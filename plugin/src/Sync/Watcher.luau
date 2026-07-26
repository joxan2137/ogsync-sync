--!strict
-- Studio → daemon change detection. TextDocumentDidChange covers locally open
-- documents; the per-script Source signal is what carries Team Create
-- collaborator edits, so every script under a root gets one.

local Applier = require(script.Parent.Applier)
local Hash = require(script.Parent.Parent.Util.Hash)
local Net = require(script.Parent.Parent.Net)
local Path = require(script.Parent.Parent.Util.Path)

local DEBOUNCE_SECONDS = 0.3
local SOURCE_EVENT_CAP = 524288

-- Studio-only service: absent DataModels (play sessions) must not break require.
local ScriptEditorService: ScriptEditorService? = nil
do
	local ok, service = pcall(function(): Instance
		return game:GetService("ScriptEditorService")
	end)
	if ok then
		ScriptEditorService = service :: ScriptEditorService
	end
end

local Watcher = {}

local started = false
local roots: {Instance} = {}
local globalConnections: {RBXScriptConnection} = {}
local rootConnections: {RBXScriptConnection} = {}
local watched: {[Instance]: {RBXScriptConnection}} = {}
local knownPaths: {[Instance]: string} = {}
local timers: {[Instance]: thread} = {}

local function nowMillis(): number
	return DateTime.now().UnixTimestampMillis
end

local function isSynced(inst: Instance): boolean
	for _, root in roots do
		if inst == root or inst:IsDescendantOf(root) then
			return true
		end
	end
	return false
end

local function isTracked(inst: Instance): boolean
	return inst:IsA("LuaSourceContainer") or inst:IsA("Folder")
end

local function emitScriptChanged(inst: Instance)
	if inst.Parent == nil or not isSynced(inst) then
		return
	end
	local path = Path.of(inst)
	local source = Applier.sourceOf(inst)
	local hash = Hash.content(source)
	if Applier.wasEcho(path, hash) then
		return
	end
	knownPaths[inst] = path
	Net.pushEvent({
		ev = "scriptChanged",
		path = path,
		source = if #source <= SOURCE_EVENT_CAP then source else nil,
		hash = hash,
		ts = nowMillis(),
	})
end

local function scheduleScriptChanged(inst: Instance)
	local pending = timers[inst]
	if pending then
		task.cancel(pending)
	end
	timers[inst] = task.delay(DEBOUNCE_SECONDS, function()
		timers[inst] = nil
		emitScriptChanged(inst)
	end)
end

local function cancelTimer(inst: Instance)
	local pending = timers[inst]
	if pending then
		task.cancel(pending)
		timers[inst] = nil
	end
end

local function unwatch(inst: Instance)
	local connections = watched[inst]
	if connections then
		for _, connection in connections do
			connection:Disconnect()
		end
		watched[inst] = nil
	end
	cancelTimer(inst)
	knownPaths[inst] = nil
end

local function emitRenamed(inst: Instance, oldPath: string)
	local path = Path.of(inst)
	if path == oldPath then
		return
	end
	knownPaths[inst] = path
	-- A rename moves the whole subtree: refresh cached paths so a later removal
	-- of a descendant still reports where it actually lived.
	for _, descendant in inst:GetDescendants() do
		if knownPaths[descendant] ~= nil then
			knownPaths[descendant] = Path.of(descendant)
		end
	end
	if Applier.wasEcho(path, nil) or Applier.wasEcho(oldPath, nil) then
		return
	end
	Net.pushEvent({ ev = "instRenamed", path = path, oldPath = oldPath })
end

local function watch(inst: Instance)
	if watched[inst] then
		return
	end
	local connections: {RBXScriptConnection} = {}
	knownPaths[inst] = Path.of(inst)

	if inst:IsA("LuaSourceContainer") then
		table.insert(
			connections,
			inst:GetPropertyChangedSignal("Source"):Connect(function()
				scheduleScriptChanged(inst)
			end)
		)
	end

	table.insert(
		connections,
		inst:GetPropertyChangedSignal("Name"):Connect(function()
			local oldPath = knownPaths[inst] or Path.of(inst)
			task.defer(emitRenamed, inst, oldPath)
		end)
	)

	table.insert(
		connections,
		inst.AncestryChanged:Connect(function()
			local oldPath = knownPaths[inst] or Path.of(inst)
			task.defer(function()
				if inst.Parent == nil then
					return
				end
				if not isSynced(inst) then
					unwatch(inst)
					if not Applier.wasEcho(oldPath, nil) then
						Net.pushEvent({ ev = "instRemoved", path = oldPath })
					end
					return
				end
				emitRenamed(inst, oldPath)
			end)
		end)
	)

	watched[inst] = connections
end

local function attachRoot(root: Instance)
	if isTracked(root) then
		watch(root)
	end
	for _, descendant in root:GetDescendants() do
		if isTracked(descendant) then
			watch(descendant)
		end
	end
	table.insert(
		rootConnections,
		root.DescendantAdded:Connect(function(inst: Instance)
			if not isTracked(inst) then
				return
			end
			task.defer(function()
				if inst.Parent == nil then
					return
				end
				watch(inst)
				local path = Path.of(inst)
				if Applier.wasEcho(path, nil) then
					return
				end
				Net.pushEvent({ ev = "instAdded", path = path, class = inst.ClassName })
				if inst:IsA("LuaSourceContainer") then
					emitScriptChanged(inst)
				end
			end)
		end)
	)
	table.insert(
		rootConnections,
		root.DescendantRemoving:Connect(function(inst: Instance)
			if not isTracked(inst) then
				return
			end
			local path = knownPaths[inst] or Path.of(inst)
			unwatch(inst)
			task.defer(function()
				if Applier.wasEcho(path, nil) then
					return
				end
				Net.pushEvent({ ev = "instRemoved", path = path })
			end)
		end)
	)
end

local function detachRoots()
	for _, connection in rootConnections do
		connection:Disconnect()
	end
	rootConnections = {}
	for inst in watched do
		unwatch(inst)
	end
end

function Watcher.setRoots(newRoots: {Instance})
	detachRoots()
	roots = table.clone(newRoots)
	if not started then
		return
	end
	for _, root in roots do
		attachRoot(root)
	end
end

function Watcher.start()
	if started then
		return
	end
	started = true
	local editor = ScriptEditorService
	if editor ~= nil then
		table.insert(
			globalConnections,
			editor.TextDocumentDidChange:Connect(function(document: ScriptDocument)
				local ok, inst = pcall(function(): Instance?
					return document:GetScript()
				end)
				if not ok or inst == nil then
					return
				end
				local target = inst :: Instance
				if not isSynced(target) then
					return
				end
				scheduleScriptChanged(target)
			end)
		)
	end
	for _, root in roots do
		attachRoot(root)
	end
end

function Watcher.stop()
	started = false
	for _, connection in globalConnections do
		connection:Disconnect()
	end
	globalConnections = {}
	detachRoots()
	for inst in timers do
		cancelTimer(inst)
	end
	roots = {}
end

return Watcher
