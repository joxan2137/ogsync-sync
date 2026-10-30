--!strict
-- run.exec / run.job. Edit context evaluates in the plugin VM. During a playtest
-- the server and client contexts evaluate in the GAME VM by default: an injected
-- bridge script requires a fresh ModuleScript holding the code, so it shares the
-- game's require cache instead of building a second copy of every module.
-- vm="plugin" keeps the old sandbox, and every result names the VM it ran in.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")

local Src = script.Parent.Parent :: any
local Serde = require(Src.Util.Serde)
local Output = require(Src.Util.Output)
local Jobs = require(script.Jobs)

type Register = (string, (any) -> any) -> ()
type Job = Jobs.Job

local ENCODE_DEPTH = 4
local WAIT_STEP = 0.05
local BRIDGE_NAME = "__OGSyncEval"
local BRIDGE_PROTO = 1
local BRIDGE_START_TIMEOUT = 5
local CONTAINER_TIMEOUT = 5

local luauLoad = loadstring
local setEnv = setfenv
local getEnv = getfenv

local registry = Jobs.new()
local bridgeInvoke: BindableFunction? = nil

local function encodeValue(value: any): any
	local ok, encoded = pcall(Serde.encode, value, ENCODE_DEPTH)
	return if ok then encoded else tostring(value)
end

local function stringify(value: any): string
	if type(value) == "table" then
		local ok, json = pcall(function()
			return HttpService:JSONEncode(encodeValue(value))
		end)
		if ok then
			return json
		end
	end
	return tostring(value)
end

local function jobContext(job: Job): any
	return {
		id = job.id,
		gen = job.gen,
		key = job.key,
		alive = function(): boolean
			return registry:isCurrent(job)
		end,
		delay = function(seconds: number, fn: (...any) -> ...any, ...: any): thread
			return task.delay(seconds, registry:guard(job, fn), ...)
		end,
	}
end

local function startInPlugin(job: Job, code: string)
	local chunk, compileErr = luauLoad(code, "=ogsync.run")
	if not chunk then
		registry:finish(job, false, "compile error: " .. tostring(compileErr))
		return
	end
	local function emitter(level: string): (...any) -> ()
		return function(...)
			local parts = {}
			for index = 1, select("#", ...) do
				table.insert(parts, stringify((select(index, ...))))
			end
			registry:emit(job, level, table.concat(parts, " "))
		end
	end
	local sandbox = {
		print = emitter("info"),
		warn = emitter("warn"),
		error = function(message: any, level: number?)
			registry:emit(job, "error", tostring(message))
			error(message, (level or 1) + 1)
		end,
		ogsync = jobContext(job),
	}
	setEnv(chunk, setmetatable(sandbox, { __index = getEnv(0) }))

	local thread = task.spawn(function()
		local results = table.pack(xpcall(chunk, function(err: any): string
			return tostring(err) .. "\n" .. debug.traceback(nil, 2)
		end))
		if not results[1] then
			registry:finish(job, false, results[2])
			return
		end
		local returns = {}
		for index = 2, results.n do
			table.insert(returns, encodeValue(results[index]))
		end
		registry:finish(job, true, returns)
	end)
	job.onCancel = function()
		pcall(task.cancel, thread)
	end
end

local function bridgeContainer(): Instance
	if RunService:IsServer() then
		return ServerScriptService
	end
	local player = Players.LocalPlayer
	local container = if player then player:WaitForChild("PlayerScripts", CONTAINER_TIMEOUT) else nil
	if container == nil then
		error("game-VM eval unsupported: this client has no PlayerScripts to host the bridge (pass vm=\"plugin\")", 0)
	end
	return container
end

-- One bridge per play DataModel. Plugin-created scripts run in a playtest
-- because Studio compiles them from Source; if this Studio build refuses, the
-- bridge never reports Ready and the eval fails loudly instead of silently
-- falling back to the plugin VM.
local function ensureBridge(): BindableFunction
	local cached = bridgeInvoke
	if cached ~= nil and cached.Parent ~= nil and cached.Parent.Parent ~= nil then
		return cached
	end
	local container = bridgeContainer()
	local existing = container:FindFirstChild(BRIDGE_NAME)
	if existing ~= nil then
		local invoke = existing:FindFirstChild("Invoke")
		if existing:GetAttribute("Proto") == BRIDGE_PROTO and existing:GetAttribute("Ready") == true and invoke ~= nil and invoke:IsA("BindableFunction") then
			bridgeInvoke = invoke
			return invoke
		end
		existing:Destroy()
	end

	local host = Instance.new(if RunService:IsServer() then "Script" else "LocalScript")
	host.Name = BRIDGE_NAME
	host.Archivable = false
	host:SetAttribute("Proto", BRIDGE_PROTO)
	local core = script.Bridge:Clone()
	core.Parent = host
	Src.Util.Serde:Clone().Parent = host
	Src.Util.Path:Clone().Parent = host
	local invoke = Instance.new("BindableFunction")
	invoke.Name = "Invoke"
	invoke.Parent = host
	local okSource, sourceErr = pcall(function()
		(host :: any).Source = "require(script.Bridge)(script, require(script.Serde))\n"
	end)
	if not okSource then
		host:Destroy()
		error("game-VM eval unsupported: cannot set the bridge script's Source (" .. tostring(sourceErr) .. ")", 0)
	end
	host.Parent = container

	local deadline = os.clock() + BRIDGE_START_TIMEOUT
	while host:GetAttribute("Ready") ~= true and os.clock() < deadline do
		task.wait(WAIT_STEP)
	end
	if host:GetAttribute("Ready") ~= true then
		host:Destroy()
		error(
			string.format(
				"game-VM eval unsupported: the injected %s did not start within %ds (scripts created at runtime are not running here); pass vm=\"plugin\" to eval in the plugin VM",
				host.ClassName,
				BRIDGE_START_TIMEOUT
			),
			0
		)
	end
	bridgeInvoke = invoke
	return invoke
end

local function absorb(job: Job, reply: any)
	local ok, decoded = pcall(function()
		return HttpService:JSONDecode(reply)
	end)
	if not ok or type(decoded) ~= "table" then
		return nil
	end
	if type(decoded.output) == "table" then
		job.output = decoded.output
	end
	if type(decoded.dropped) == "number" then
		job.dropped = decoded.dropped
	end
	return decoded
end

local function startInGame(job: Job, code: string)
	local invoke = ensureBridge()
	local module = Instance.new("ModuleScript")
	module.Name = "Eval"
	-- Same line as the first line of code, so error line numbers match the input.
	module.Source = "return function(print, warn, ogsync, ...) " .. code .. "\nend\n"
	job.onCancel = function()
		task.spawn(function()
			pcall(function()
				invoke:Invoke({ kind = "cancel", id = job.id })
			end)
		end)
	end
	task.spawn(function()
		local ok, reply = pcall(function()
			return invoke:Invoke({ kind = "exec", id = job.id, gen = job.gen, module = module })
		end)
		module:Destroy()
		if not ok then
			registry:finish(job, false, "game-VM bridge failed: " .. tostring(reply))
			return
		end
		local decoded = absorb(job, reply)
		if decoded == nil then
			registry:finish(job, false, "game-VM bridge returned an unreadable reply")
		elseif decoded.status == "done" then
			registry:finish(job, true, decoded.returns or {})
		elseif decoded.status ~= "cancelled" then
			registry:finish(job, false, decoded.err or "eval failed")
		end
	end)
end

-- Live output of a running game-VM job sits in the bridge until it finishes.
local function refresh(job: Job)
	local invoke = bridgeInvoke
	if job.vm ~= "game" or job.status ~= "running" or invoke == nil then
		return
	end
	local ok, reply = pcall(function()
		return invoke:Invoke({ kind = "peek", id = job.id })
	end)
	if ok then
		absorb(job, reply)
	end
end

local function waitSettled(job: Job, seconds: number)
	local deadline = os.clock() + seconds
	while job.status == "running" and os.clock() < deadline do
		task.wait(WAIT_STEP)
	end
end

local function settledResult(job: Job): any
	local snapshot = registry:snapshot(job)
	local list, truncated = Output.capList(snapshot.output)
	snapshot.output = list
	snapshot.truncated = truncated or job.dropped > 0
	return snapshot
end

local function failure(job: Job): string
	local trailer = ""
	if #job.output > 0 then
		local lines = {}
		for _, entry in job.output do
			table.insert(lines, entry.text)
		end
		trailer = "\n--- output ---\n" .. table.concat(lines, "\n")
	end
	return string.format("%s [vm=%s]%s", tostring(job.err), job.vm, trailer)
end

local function broker(): any
	local ok, module = pcall(function()
		return require(Src.Broker)
	end)
	if not ok or type(module) ~= "table" or type(module.toClient) ~= "function" then
		error("run.exec context=client needs the play-server broker — this session has none")
	end
	return module
end

local function exec(args: any, context: string): any
	if type(args.code) ~= "string" then
		error("run.exec requires `code` as a string")
	end
	local vm = args.vm or (if context == "edit" then "plugin" else "game")
	if vm ~= "game" and vm ~= "plugin" then
		error("unknown vm '" .. tostring(vm) .. "' (game|plugin)")
	end
	if vm == "game" and not RunService:IsRunning() then
		error("vm=game needs a running playtest; the edit DataModel has no game VM")
	end

	local job = registry:start({
		key = if type(args.key) == "string" then args.key else nil,
		vm = vm,
		context = context,
	})
	local ok, err = pcall(if vm == "game" then startInGame else startInPlugin, job, args.code)
	if not ok then
		registry:take(job.id)
		error(err, 0)
	end
	if args.async == true then
		return { job = job.id, gen = job.gen, key = job.key, vm = vm, context = context, async = true }
	end

	waitSettled(job, math.huge)
	registry:take(job.id)
	if job.status ~= "done" then
		error(failure(job), 0)
	end
	return settledResult(job)
end

return function(register: Register)
	register("run.exec", function(args: any): any
		-- Dispatcher routes client jobs on `args.ctx`; the tool contract calls it
		-- `context` — accept either so neither spelling silently runs in edit.
		local context = args.context or args.ctx or "edit"
		if context == "edit" then
			return exec(args, context)
		elseif context == "server" then
			if not RunService:IsRunning() then
				error("run.exec context=server requires an active playtest")
			end
			return exec(args, context)
		elseif context == "client" then
			if not RunService:IsRunning() then
				error("run.exec context=client requires an active playtest")
			end
			-- A client DataModel (and single-DataModel solo/run) *is* the client
			-- context, so run here instead of brokering the job back to ourselves.
			if RunService:IsClient() then
				return exec(args, context)
			end
			local result = broker().toClient({ op = "run.exec", args = args })
			if type(result) == "table" and (result :: any).ok == false then
				error(tostring((result :: any).err or "client execution failed"))
			end
			return if type(result) == "table" then (result :: any).data else result
		end
		error("unknown run context '" .. tostring(context) .. "' (edit|server|client)")
	end)

	register("run.job", function(args: any): any
		local action = args.action or "poll"
		if action == "list" then
			return { jobs = registry:list() }
		end
		local id = tostring(args.id)
		local job = registry:get(id)
		if job == nil then
			error(string.format("no job %s in this session (finished jobs are kept until collected, newest 32 only)", id))
		end
		local found = job :: Job
		if action == "cancel" then
			registry:cancel(found, "cancelled by request")
			return settledResult(found)
		elseif action == "poll" then
			refresh(found)
			return settledResult(found)
		elseif action == "collect" then
			waitSettled(found, math.max(tonumber(args.wait_ms) or 0, 0) / 1000)
			refresh(found)
			if found.status ~= "running" then
				registry:take(id)
			end
			return settledResult(found)
		end
		error("unknown job action '" .. tostring(action) .. "' (poll|collect|cancel|list)")
	end)
end
