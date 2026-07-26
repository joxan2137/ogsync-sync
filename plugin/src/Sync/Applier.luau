--!strict
-- sync.apply / sync.snapshot / sync.hash (docs/PROTOCOL.md §Sync ops) plus the
-- echo-suppression record Watcher reads before pushing a change event.

local Hash = require(script.Parent.Parent.Util.Hash)
local Path = require(script.Parent.Parent.Util.Path)

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

local STRUCTURAL_WINDOW = 2

local Applier = {}

local rootPaths: {string} = {}
local rootInstances: {Instance} = {}
local lastApplied: {[string]: string} = {}
local lastStructural: {[string]: number} = {}
local pending = 0

Applier.onRootsChanged = nil :: ((roots: {Instance}) -> ())?
-- UI.setState, injected by init: reports how many changes are still queued here.
Applier.onSyncState = nil :: ((partial: {[string]: any}) -> ())?

local function reportPending()
	local listener = Applier.onSyncState
	if listener ~= nil then
		pcall(listener, { pending = pending })
	end
end

-- An open document holds edits that have not reached .Source yet; Watcher and
-- Applier must read the same text or their hashes disagree.
local function sourceOf(inst: Instance): string
	local editor = ScriptEditorService
	if editor ~= nil then
		local okDocument, document = pcall(function(): ScriptDocument?
			return editor:FindScriptDocument(inst :: LuaSourceContainer)
		end)
		if okDocument and document ~= nil then
			local okText, text = pcall(function(): string
				return (document :: ScriptDocument):GetText()
			end)
			if okText and type(text) == "string" then
				return text
			end
		end
	end
	local ok, source = pcall(function(): string
		return (inst :: any).Source
	end)
	return if ok and type(source) == "string" then source else ""
end

local function hashOf(inst: Instance): string
	if inst:IsA("LuaSourceContainer") then
		return Hash.content(sourceOf(inst))
	end
	return Hash.content("")
end

local function runContextOf(inst: Instance): string?
	if inst:IsA("ModuleScript") then
		return "module"
	elseif inst:IsA("LocalScript") then
		return "client"
	elseif inst:IsA("Script") then
		local context = (inst :: Script).RunContext
		if context == Enum.RunContext.Client then
			return "client"
		elseif context == Enum.RunContext.Plugin then
			return "plugin"
		end
		return "server"
	end
	return nil
end

-- Daemon paths and Path.of output can differ in bracket form for the same
-- instance; record both so Watcher's echo check always hits.
local function markStructural(path: string, inst: Instance?)
	lastStructural[path] = os.clock()
	if inst ~= nil then
		local canonical = Path.of(inst)
		if canonical ~= path then
			lastStructural[canonical] = os.clock()
		end
	end
end

local function markApplied(path: string, hash: string, inst: Instance?)
	lastApplied[path] = hash
	if inst ~= nil then
		local canonical = Path.of(inst)
		if canonical ~= path then
			lastApplied[canonical] = hash
		end
	end
end

function Applier.setRoots(paths: {string})
	rootPaths = table.clone(paths)
	rootInstances = {}
	for _, path in paths do
		local inst = Path.resolve(path)
		if inst then
			table.insert(rootInstances, inst)
		end
	end
	local listener = Applier.onRootsChanged
	if listener then
		listener(rootInstances)
	end
end

function Applier.roots(): {Instance}
	return rootInstances
end

Applier.sourceOf = sourceOf
Applier.hashOf = hashOf

function Applier.rootPaths(): {string}
	return rootPaths
end

-- hash omitted (nil) asks about a structural change: creates/deletes/renames we
-- just applied would otherwise bounce straight back as Watcher events.
function Applier.wasEcho(path: string, hash: string?): boolean
	if hash ~= nil then
		if lastApplied[path] == hash then
			lastApplied[path] = nil
			return true
		end
		return false
	end
	local at = lastStructural[path]
	return at ~= nil and (os.clock() - at) < STRUCTURAL_WINDOW
end

local function writeSource(inst: Instance, source: string): string?
	local editor = ScriptEditorService
	local err: any = "ScriptEditorService unavailable"
	if editor ~= nil then
		local ok
		ok, err = pcall(function()
			editor:UpdateSourceAsync(inst, function(): string
				return source
			end)
		end)
		if ok then
			return nil
		end
	end
	-- Containers the script editor refuses (no open document support) still
	-- accept a direct write; open documents never reach this branch.
	local okDirect = pcall(function()
		(inst :: any).Source = source
	end)
	if okDirect then
		return nil
	end
	return tostring(err)
end

local applyChange: (change: {[string]: any}) -> {[string]: any}

local function applyCreate(change: {[string]: any}): {[string]: any}
	local path = change.path
	local parentPath, name, splitErr = Path.split(path)
	if parentPath == nil or name == nil then
		return { ok = false, err = splitErr or "bad path" }
	end
	local parent, parentErr = Path.resolve(parentPath)
	if not parent then
		return { ok = false, err = parentErr or "no parent" }
	end
	local existing = parent:FindFirstChild(name)
	if existing then
		return applyChange({
			kind = "write",
			path = path,
			source = change.source,
			class = change.class,
			baseHash = change.baseHash,
		})
	end
	local className = if type(change.class) == "string" then change.class else "ModuleScript"
	local okNew, created = pcall(function(): Instance
		return Instance.new(className :: any)
	end)
	if not okNew then
		return { ok = false, err = string.format("cannot create %s", tostring(className)) }
	end
	local inst = created :: Instance
	inst.Name = name
	local source = if type(change.source) == "string" then change.source else ""
	if inst:IsA("LuaSourceContainer") and source ~= "" then
		local okSource = pcall(function()
			(inst :: any).Source = source
		end)
		if not okSource then
			inst:Destroy()
			return { ok = false, err = string.format("%s has no Source", className) }
		end
	end
	inst.Parent = parent
	local hash = Hash.content(source)
	markApplied(path, hash, inst)
	markStructural(path, inst)
	return { ok = true, hash = hash }
end

local function applyWrite(change: {[string]: any}): {[string]: any}
	local path = change.path
	local inst, resolveErr = Path.resolve(path)
	if not inst then
		if type(change.class) == "string" then
			return applyCreate(change)
		end
		return { ok = false, err = resolveErr or "no instance" }
	end
	if not inst:IsA("LuaSourceContainer") then
		return { ok = false, err = string.format("%s is a %s, not a script", path, inst.ClassName) }
	end
	local currentHash = hashOf(inst)
	if type(change.baseHash) == "string" and change.baseHash ~= currentHash then
		return { ok = false, conflictHash = currentHash }
	end
	local source = if type(change.source) == "string" then change.source else ""
	local newHash = Hash.content(source)
	if newHash ~= currentHash then
		local err = writeSource(inst, source)
		if err then
			return { ok = false, err = err }
		end
	end
	markApplied(path, newHash, inst)
	return { ok = true, hash = newHash }
end

local function applyDelete(change: {[string]: any}): {[string]: any}
	local path = change.path
	local inst = Path.resolve(path)
	if not inst then
		markStructural(path)
		return { ok = true }
	end
	if inst == game then
		return { ok = false, err = "refusing to delete game" }
	end
	if inst.Parent == game and Path.SERVICES[inst.Name] then
		return { ok = false, err = string.format("refusing to delete service %s", inst.Name) }
	end
	markStructural(path, inst)
	local ok, err = pcall(function()
		inst:Destroy()
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	lastApplied[path] = nil
	return { ok = true }
end

local function applyRename(change: {[string]: any}): {[string]: any}
	local path = change.path
	if type(change.newName) ~= "string" or change.newName == "" then
		return { ok = false, err = "rename needs newName" }
	end
	local inst, resolveErr = Path.resolve(path)
	if not inst then
		return { ok = false, err = resolveErr or "no instance" }
	end
	markStructural(path, inst)
	local ok, err = pcall(function()
		inst.Name = change.newName
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	local newPath = Path.of(inst)
	markStructural(newPath)
	local applied = lastApplied[path]
	if applied then
		lastApplied[path] = nil
		lastApplied[newPath] = applied
	end
	return { ok = true, path = newPath }
end

function applyChange(change: {[string]: any}): {[string]: any}
	if type(change) ~= "table" or type(change.path) ~= "string" then
		return { ok = false, err = "change needs path" }
	end
	local kind = change.kind
	if kind == "write" then
		return applyWrite(change)
	elseif kind == "create" then
		return applyCreate(change)
	elseif kind == "delete" then
		return applyDelete(change)
	elseif kind == "rename" then
		return applyRename(change)
	end
	return { ok = false, err = string.format("unknown change kind '%s'", tostring(kind)) }
end

function Applier.apply(args: any): {any}
	if type(args) ~= "table" or type(args.changes) ~= "table" then
		error("sync.apply needs changes", 0)
	end
	local changes = args.changes :: {any}
	local results: {any} = {}
	pending += #changes
	reportPending()
	for index, change in changes do
		results[index] = applyChange(change)
		pending -= 1
		if pending % 10 == 0 then
			reportPending()
		end
	end
	reportPending()
	return results
end

function Applier.snapshot(args: any): {any}
	local paths = if type(args) == "table" and type(args.roots) == "table" then args.roots :: {string} else rootPaths
	if #paths == 0 then
		error("sync.snapshot needs roots", 0)
	end
	Applier.setRoots(paths)
	local entries: {any} = {}
	local seen: {[Instance]: boolean} = {}
	local function visit(inst: Instance)
		if seen[inst] then
			return
		end
		if inst:IsA("LuaSourceContainer") or inst:IsA("Folder") then
			seen[inst] = true
			table.insert(entries, {
				path = Path.of(inst),
				class = inst.ClassName,
				hash = hashOf(inst),
				runCtx = runContextOf(inst),
			})
		end
	end
	for _, root in rootInstances do
		visit(root)
		for _, descendant in root:GetDescendants() do
			visit(descendant)
		end
	end
	return entries
end

function Applier.hash(args: any): {any}
	if type(args) ~= "table" or type(args.paths) ~= "table" then
		error("sync.hash needs paths", 0)
	end
	local out: {any} = {}
	for index, path in args.paths :: {string} do
		local inst = Path.resolve(path)
		if inst then
			out[index] = { path = path, hash = hashOf(inst) }
		else
			out[index] = { path = path, missing = true }
		end
	end
	return out
end

function Applier.install(register: (opName: string, handler: (args: any) -> any) -> ())
	register("sync.apply", Applier.apply)
	register("sync.snapshot", Applier.snapshot)
	register("sync.hash", Applier.hash)
end

return Applier
