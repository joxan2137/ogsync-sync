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

-- Structural echoes only cover the round trip of one apply; anything later is a
-- real user action on that path and must reach the daemon.
local STRUCTURAL_WINDOW = 0.6
local ECHO_TTL = 60
local ECHO_LIMIT = 512

local Applier = {}

export type StructuralKind = "create" | "delete" | "rename"

type EchoRecord = { at: number, hash: string? }

local rootPaths: {string} = {}
local rootInstances: {Instance} = {}
-- lastApplied is keyed by path, lastStructural by `kind .. "|" .. path`.
local lastApplied: {[string]: EchoRecord} = {}
local lastStructural: {[string]: EchoRecord} = {}
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

-- Everything that crosses the bridge (sources and the hashes over them) is
-- LF-only, matching normalizeSource() in server/src/proto/types.ts. Studio keeps
-- whatever line endings it has; only the wire form is normalized.
local function toLf(source: string): string
	if string.find(source, "\r", 1, true) == nil then
		return source
	end
	return (string.gsub(source, "\r\n", "\n"))
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
				return toLf(text)
			end
		end
	end
	local ok, source = pcall(function(): string
		return (inst :: any).Source
	end)
	return if ok and type(source) == "string" then toLf(source) else ""
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

-- Echo records outlive the apply that wrote them, so a session that writes many
-- one-off paths would leak: expired records go, and the oldest survivor makes
-- room for the incoming one once the map is full.
local function evict(records: {[string]: EchoRecord})
	local now = os.clock()
	local count = 0
	local oldestKey: string? = nil
	local oldestAt = math.huge
	for key, record in records do
		if now - record.at > ECHO_TTL then
			records[key] = nil
		else
			count += 1
			if record.at < oldestAt then
				oldestAt = record.at
				oldestKey = key
			end
		end
	end
	if count >= ECHO_LIMIT and oldestKey ~= nil then
		records[oldestKey] = nil
	end
end

-- Daemon paths and Path.of output can differ in bracket form for the same
-- instance; record both so Watcher's echo check always hits. The kind is part of
-- the key: the create we just applied must not swallow a user's delete of it.
local function markStructural(kind: StructuralKind, path: string, inst: Instance?)
	evict(lastStructural)
	local at = os.clock()
	lastStructural[kind .. "|" .. path] = { at = at }
	if inst ~= nil then
		local canonical = Path.of(inst)
		if canonical ~= path then
			lastStructural[kind .. "|" .. canonical] = { at = at }
		end
	end
end

local function markApplied(path: string, hash: string, inst: Instance?)
	evict(lastApplied)
	local at = os.clock()
	lastApplied[path] = { at = at, hash = hash }
	if inst ~= nil then
		local canonical = Path.of(inst)
		if canonical ~= path then
			lastApplied[canonical] = { at = at, hash = hash }
		end
	end
end

local function resolveRoots(paths: {string}): {Instance}
	local instances: {Instance} = {}
	for _, path in paths do
		local inst = Path.resolve(path)
		if inst then
			table.insert(instances, inst)
		end
	end
	return instances
end

-- Instances are compared too: a root replaced in Studio carries dead Watcher
-- connections even though its path never changed.
local function rootsUnchanged(paths: {string}, instances: {Instance}): boolean
	if #paths ~= #rootPaths or #instances ~= #rootInstances then
		return false
	end
	for index, path in paths do
		if rootPaths[index] ~= path or rootInstances[index] ~= instances[index] then
			return false
		end
	end
	return true
end

function Applier.setRoots(paths: {string})
	rootPaths = table.clone(paths)
	rootInstances = resolveRoots(rootPaths)
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

-- The record survives repeated hits: the Source signal and
-- TextDocumentDidChange can report the same applied content in two different
-- debounce windows, and only the second one would look like a user edit. It is
-- dropped as soon as a different hash proves the path really changed.
function Applier.wasEcho(path: string, hash: string): boolean
	local record = lastApplied[path]
	if record == nil then
		return false
	end
	if os.clock() - record.at > ECHO_TTL then
		lastApplied[path] = nil
		return false
	end
	if record.hash == hash then
		return true
	end
	lastApplied[path] = nil
	return false
end

-- Structural echo: the create/delete/rename we just applied bounces back as a
-- Watcher event. Matched on kind as well as path, and over a window short enough
-- that a user acting on the same path is never mistaken for the echo.
function Applier.wasStructuralEcho(kind: StructuralKind, path: string): boolean
	local record = lastStructural[kind .. "|" .. path]
	return record ~= nil and (os.clock() - record.at) < STRUCTURAL_WINDOW
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

local function applyWriteTo(inst: Instance, path: string, change: {[string]: any}): {[string]: any}
	if not inst:IsA("LuaSourceContainer") then
		return { ok = false, err = string.format("%s is a %s, not a script", path, inst.ClassName) }
	end
	local currentHash = hashOf(inst)
	if type(change.baseHash) == "string" and change.baseHash ~= currentHash then
		return { ok = false, conflictHash = currentHash }
	end
	local source = toLf(if type(change.source) == "string" then change.source else "")
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
		-- The daemon sends create without a baseHash whenever it has no shadow
		-- entry for the path; an instance already sitting there is the "conflict"
		-- arm of its decide table, never something to overwrite blind.
		if type(change.baseHash) ~= "string" then
			return { ok = false, conflictHash = hashOf(existing) }
		end
		return applyWriteTo(existing, path, change)
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
	local source = toLf(if type(change.source) == "string" then change.source else "")
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
	markStructural("create", path, inst)
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
	return applyWriteTo(inst, path, change)
end

-- Deletes are the one change that cannot be undone from the daemon's shadow, so
-- they only go through on proof: a baseHash that still matches Studio, or
-- `force = true`, the daemon's explicit "delete anyway" after the user resolved
-- the conflict. An unversioned delete of live source is refused as a conflict.
local function applyDelete(change: {[string]: any}): {[string]: any}
	local path = change.path
	local inst = Path.resolve(path)
	if not inst then
		markStructural("delete", path)
		return { ok = true }
	end
	if inst == game then
		return { ok = false, err = "refusing to delete game" }
	end
	if inst.Parent == game and Path.SERVICES[inst.Name] then
		return { ok = false, err = string.format("refusing to delete service %s", inst.Name) }
	end
	local currentHash = hashOf(inst)
	if type(change.baseHash) == "string" then
		if change.baseHash ~= currentHash then
			return { ok = false, conflictHash = currentHash }
		end
	elseif change.force ~= true and inst:IsA("LuaSourceContainer") and sourceOf(inst) ~= "" then
		return { ok = false, conflictHash = currentHash }
	end
	markStructural("delete", path, inst)
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
	markStructural("rename", path, inst)
	local ok, err = pcall(function()
		inst.Name = change.newName
	end)
	if not ok then
		return { ok = false, err = tostring(err) }
	end
	local newPath = Path.of(inst)
	markStructural("rename", newPath)
	local applied = lastApplied[path]
	if applied then
		lastApplied[path] = nil
		lastApplied[newPath] = applied
	end
	return { ok = true, path = newPath }
end

local function applyChange(change: {[string]: any}): {[string]: any}
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
	-- Seating roots tears down Watcher's connections, and with them every
	-- debounced edit still waiting to be pushed. Do it on the first snapshot and
	-- only again when the roots themselves actually change.
	local instances = resolveRoots(paths)
	if not rootsUnchanged(paths, instances) then
		Applier.setRoots(paths)
	end
	local entries: {any} = {}
	local seen: {[Instance]: boolean} = {}
	local function visit(inst: Instance)
		if seen[inst] then
			return
		end
		if inst:IsA("LuaSourceContainer") or inst:IsA("Folder") then
			seen[inst] = true
			local path, ambiguous = Path.ofChecked(inst)
			table.insert(entries, {
				path = path,
				class = inst.ClassName,
				hash = hashOf(inst),
				runCtx = runContextOf(inst),
				-- Duplicate sibling names collapse onto one path: flagged so the
				-- daemon can skip the row instead of writing one twin over the other.
				ambiguous = if ambiguous then true else nil,
			})
		end
	end
	for _, root in instances do
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
