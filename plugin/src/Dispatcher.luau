--!strict
-- Op registry. Ops/* modules each return `function(register) ... end`; they are
-- required defensively so a missing or broken domain module never stops the
-- plugin from loading.

local Applier = require(script.Parent.Sync.Applier)
local Output = require(script.Parent.Util.Output)
local Panel = require(script.Parent.UI.Panel)
local Path = require(script.Parent.Util.Path)

local OPS_MODULES = {
	"Inst", "Script", "Run", "Play", "Log", "Shot",
	"Prof", "Input", "Asset", "Rbxm", "Hist", "Sel",
}

export type Job = { id: string, op: string, args: any }

export type JobResult = {
	id: string,
	ok: boolean,
	data: any?,
	err: string?,
	partial: boolean?,
}

export type Context = { plugin: Plugin, role: string, session: string }

local Dispatcher = {}

-- Cross-DataModel stop channel: written by play.stopSignal here, polled by the
-- play-session monitor in init.server.luau.
Dispatcher.STOP_SETTING = "ogsync_stop_token"

local handlers: {[string]: (args: any) -> any} = {}
local clientRouter: ((job: Job) -> any)? = nil

function Dispatcher.register(opName: string, handler: (args: any) -> any)
	handlers[opName] = handler
end

-- Play-server sessions route client-context jobs over the RemoteFunction broker;
-- set by init so Ops modules stay free of core dependencies.
function Dispatcher.setClientRouter(router: ((job: Job) -> any)?)
	clientRouter = router
end

local function registerCoreOps(ctx: Context)
	Applier.install(Dispatcher.register)

	-- Informational: the daemon pushes the current conflict list for the panel.
	Dispatcher.register("sync.conflicts", function(args: any): any
		local list = if type(args) == "table" then (args :: any).list else nil
		if type(list) ~= "table" then
			error("sync.conflicts needs list", 0)
		end
		Panel.setState({ conflicts = list })
		return { ok = true }
	end)

	-- sel.get is registered by Ops/Sel.luau ({paths, truncated, total}); no
	-- core fallback so exactly one result shape exists on the wire.

	Dispatcher.register("play.stopSignal", function(): any
		if ctx.role ~= "edit" then
			error("play.stopSignal must run in the edit session", 0)
		end
		local token = game:GetService("HttpService"):GenerateGUID(false)
		ctx.plugin:SetSetting(Dispatcher.STOP_SETTING, token)
		return { token = token }
	end)
end

local function loadOpsModules()
	local folder = script.Parent:FindFirstChild("Ops")
	if folder == nil then
		warn("[OGSync] Ops folder missing — only core ops are available")
		return
	end
	for _, name in OPS_MODULES do
		local module = folder:FindFirstChild(name)
		if module == nil then
			warn(string.format("[OGSync] Ops.%s missing — its ops are unavailable", name))
			continue
		end
		local okRequire, loaded = pcall(require, module)
		if not okRequire then
			warn(string.format("[OGSync] Ops.%s failed to load: %s", name, tostring(loaded)))
			continue
		end
		if type(loaded) ~= "function" then
			warn(string.format("[OGSync] Ops.%s did not return an install function", name))
			continue
		end
		local okInstall, installErr = pcall(loaded :: any, Dispatcher.register)
		if not okInstall then
			warn(string.format("[OGSync] Ops.%s failed to register: %s", name, tostring(installErr)))
		end
	end
end

function Dispatcher.setup(ctx: Context)
	registerCoreOps(ctx)
	loadOpsModules()
end

function Dispatcher.dispatch(job: Job): JobResult
	local router = clientRouter
	local args = if type(job.args) == "table" then job.args :: any else nil
	-- The wire uses `ctx`, the MCP tool contract uses `context`: honour both so a
	-- client-context job is never silently executed on the play server.
	if router ~= nil and args ~= nil and (args.ctx == "client" or args.context == "client") then
		local okRoute, routed = pcall(router, job)
		if not okRoute then
			return { id = job.id, ok = false, err = tostring(routed) }
		end
		if type(routed) == "table" then
			local result = routed :: any
			return { id = job.id, ok = result.ok == true, data = result.data, err = result.err }
		end
		return { id = job.id, ok = true, data = routed }
	end

	local handler = handlers[job.op]
	if handler == nil then
		return { id = job.id, ok = false, err = string.format("unknown op '%s'", tostring(job.op)) }
	end

	local ok, value = pcall(handler, job.args)
	if not ok then
		return { id = job.id, ok = false, err = tostring(value) }
	end

	local capped, capErr = Output.capResult(value)
	if capErr ~= nil then
		return { id = job.id, ok = false, err = capErr }
	end
	return { id = job.id, ok = true, data = capped }
end

return Dispatcher
