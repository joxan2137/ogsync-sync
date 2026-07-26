--!nonstrict
-- Studio stand-ins for running plugin/src modules under lune: a minimal instance
-- tree, the two services the sync modules touch, and a controllable clock. Each
-- Harness.new() is an isolated DataModel with its own module cache, so tests
-- never leak echo records or roots into each other.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local serde = require("@lune/serde")

local Harness = {}

local ANCESTRY: { [string]: { string } } = {
	Instance = { "Instance" },
	DataModel = { "DataModel", "ServiceProvider", "Instance" },
	Folder = { "Folder", "Instance" },
	LuaSourceContainer = { "LuaSourceContainer", "Instance" },
	BaseScript = { "BaseScript", "LuaSourceContainer", "Instance" },
	Script = { "Script", "BaseScript", "LuaSourceContainer", "Instance" },
	LocalScript = { "LocalScript", "BaseScript", "LuaSourceContainer", "Instance" },
	ModuleScript = { "ModuleScript", "LuaSourceContainer", "Instance" },
	Part = { "Part", "BasePart", "Instance" },
}

local SERVICE_CLASS: { [string]: string } = {
	ScriptEditorService = "Instance",
	HttpService = "Instance",
	Selection = "Instance",
	ServerScriptService = "Folder",
	ReplicatedStorage = "Folder",
	ServerStorage = "Folder",
	StarterPlayer = "Folder",
	Workspace = "Folder",
}

local function findSourceDir(): string
	for _, candidate in { "plugin/src", "../src", "../../plugin/src", "src" } do
		if fs.isDir(candidate) then
			return candidate
		end
	end
	error(`cannot locate plugin/src from {process.cwd}`)
end

local function isA(self, className: string): boolean
	for _, name in ANCESTRY[self.ClassName] or { self.ClassName } do
		if name == className then
			return true
		end
	end
	return false
end

local methods = {}

methods.IsA = isA

function methods.GetChildren(self)
	return table.clone(self._children)
end

function methods.FindFirstChild(self, name: string)
	for _, child in self._children do
		if child.Name == name then
			return child
		end
	end
	return nil
end

function methods.GetDescendants(self)
	local out = {}
	for _, child in self._children do
		table.insert(out, child)
		for _, nested in methods.GetDescendants(child) do
			table.insert(out, nested)
		end
	end
	return out
end

function methods.IsDescendantOf(self, other): boolean
	local current = self.Parent
	while current ~= nil do
		if current == other then
			return true
		end
		current = current.Parent
	end
	return false
end

function methods.Destroy(self)
	for _, child in table.clone(self._children) do
		methods.Destroy(child)
	end
	self.Parent = nil
	rawset(self, "_destroyed", true)
end

local function detach(inst)
	local parent = rawget(inst, "_parent")
	if parent == nil then
		return
	end
	local index = table.find(parent._children, inst)
	if index ~= nil then
		table.remove(parent._children, index)
	end
end

-- Parent lives in `_parent` so that assigning it always reaches __newindex:
-- Lua only consults __newindex for keys the table does not already hold.
local instanceMeta = {
	__index = function(self, key)
		if key == "Parent" then
			return rawget(self, "_parent")
		end
		return methods[key]
	end,
	__newindex = function(self, key, value)
		if key == "Parent" then
			detach(self)
			rawset(self, "_parent", value)
			if value ~= nil then
				table.insert(value._children, self)
			end
			return
		end
		if key == "Source" and not isA(self, "LuaSourceContainer") then
			error(`{self.ClassName} has no property Source`, 0)
		end
		rawset(self, key, value)
	end,
	__tostring = function(self)
		return self.Name
	end,
}

local function newInstance(className: string, name: string?, parent: any?)
	if ANCESTRY[className] == nil then
		error(`harness has no class {className}`, 0)
	end
	local inst = setmetatable({
		ClassName = className,
		Name = name or className,
		_children = {},
	}, instanceMeta)
	if isA(inst, "LuaSourceContainer") then
		rawset(inst, "Source", "")
	end
	if isA(inst, "Script") then
		rawset(inst, "RunContext", "Server")
	end
	if parent ~= nil then
		inst.Parent = parent
	end
	return inst
end

local function newEditor(env)
	local editor = newInstance("Instance", "ScriptEditorService")
	local documents: { [any]: { text: string } } = {}
	rawset(editor, "FindScriptDocument", function(_self, inst)
		local document = documents[inst]
		if document == nil then
			return nil
		end
		return {
			GetText = function()
				return document.text
			end,
		}
	end)
	rawset(editor, "UpdateSourceAsync", function(_self, inst, transform)
		if not isA(inst, "LuaSourceContainer") then
			error(`{inst.ClassName} is not a script`, 0)
		end
		local document = documents[inst]
		local current = if document ~= nil then document.text else inst.Source
		local updated = transform(current)
		if document ~= nil then
			document.text = updated
		end
		inst.Source = updated
		env.writes += 1
	end)
	env.openDocument = function(inst, text: string)
		documents[inst] = { text = text }
	end
	return editor
end

local function newGame(env)
	local dataModel = newInstance("DataModel", "Ogsync")
	local services: { [string]: any } = {}
	rawset(dataModel, "GetService", function(_self, name: string)
		local existing = services[name]
		if existing ~= nil then
			return existing
		end
		local class = SERVICE_CLASS[name]
		if class == nil then
			error(`harness has no service {name}`, 0)
		end
		local service
		if name == "ScriptEditorService" then
			service = newEditor(env)
		elseif name == "HttpService" then
			service = newInstance(class, name)
			rawset(service, "JSONEncode", function(_svc, value)
				return serde.encode("json", value)
			end)
		else
			service = newInstance(class, name)
		end
		services[name] = service
		service.Parent = dataModel
		return service
	end)
	return dataModel
end

local function moduleToken(env, path: string)
	local existing = env._tokens[path]
	if existing ~= nil then
		return existing
	end
	local token = setmetatable({ __path = path }, {
		__index = function(_self, key: string)
			if key == "Parent" then
				local slash = string.find(path, "/[^/]*$")
				return moduleToken(env, if slash ~= nil then string.sub(path, 1, slash - 1) else "")
			end
			return moduleToken(env, if path == "" then key else `{path}/{key}`)
		end,
	})
	env._tokens[path] = token
	return token
end

function Harness.new()
	local env = {
		srcDir = findSourceDir(),
		now = 1000,
		writes = 0,
		_tokens = {},
		_modules = {},
	}

	env.game = newGame(env)
	env.newInstance = function(className: string, name: string?, parent: any?)
		return newInstance(className, name, parent)
	end
	env.advance = function(seconds: number)
		env.now += seconds
	end

	local globals = {
		game = env.game,
		Instance = {
			new = function(className: string)
				return newInstance(className)
			end,
		},
		Enum = {
			RunContext = { Legacy = "Legacy", Server = "Server", Client = "Client", Plugin = "Plugin" },
		},
		os = {
			clock = function()
				return env.now
			end,
			time = os.time,
			date = os.date,
		},
		task = {
			wait = function()
				return 0
			end,
			spawn = function(fn, ...)
				fn(...)
			end,
			defer = function(fn, ...)
				fn(...)
			end,
			delay = function(_seconds, fn)
				return fn
			end,
			cancel = function() end,
		},
		require = function(token)
			local path = if type(token) == "table" then rawget(token, "__path") else nil
			if path == nil then
				error(`harness require got {tostring(token)}`, 0)
			end
			return env.load(path)
		end,
	}

	env.load = function(path: string)
		local cached = env._modules[path]
		if cached ~= nil then
			return cached.value
		end
		local chunk = table.clone(globals)
		chunk.script = moduleToken(env, path)
		local loaded = luau.load(fs.readFile(`{env.srcDir}/{path}.luau`), {
			environment = chunk,
			debugName = path,
		})
		local value = loaded()
		env._modules[path] = { value = value }
		return value
	end

	-- Ops modules export `function(register)`; hand back the op table they build.
	env.ops = function(path: string)
		local install = env.load(path)
		local registry: { [string]: (any) -> any } = {}
		install(function(name: string, handler: (any) -> any)
			registry[name] = handler
		end)
		return registry
	end

	return env
end

return Harness
