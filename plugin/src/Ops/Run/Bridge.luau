--!strict
-- Game-VM half of run.exec. The plugin never requires this module: Ops/Run
-- clones it into a bridge script it injects into the play DataModel, and that
-- script calls it with itself and a cloned Serde. It runs at game identity, so
-- nothing here may touch plugin-only APIs. Each eval requires a fresh clone of a
-- plugin-written ModuleScript, so the code shares the game's require cache.

local HttpService = game:GetService("HttpService")

local ENCODE_DEPTH = 4
local MAX_OUTPUT_BYTES = 100 * 1024
-- Finished evals stay cancellable (their ogsync.delay timers can still be
-- disarmed by a superseding job) for this many newer evals.
local MAX_ARMED = 64

type Run = {
	status: string,
	output: { { level: string, text: string } },
	bytes: number,
	dropped: number,
	returns: { any }?,
	err: string?,
	thread: thread?,
	waiter: thread?,
}

type Arm = { cancelled: boolean }

return function(host: Instance, serde: any)
	local invoke = host:WaitForChild("Invoke") :: BindableFunction
	local running: { [string]: Run } = {}
	local armed: { [string]: Arm } = {}
	local armedOrder: { string } = {}

	local function arm(id: string): Arm
		local state: Arm = { cancelled = false }
		armed[id] = state
		table.insert(armedOrder, id)
		if #armedOrder > MAX_ARMED then
			armed[table.remove(armedOrder, 1) :: string] = nil
		end
		return state
	end

	local function encodeValue(value: any): any
		local ok, encoded = pcall(serde.encode, value, ENCODE_DEPTH)
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

	local function emitter(run: Run, level: string): (...any) -> ()
		return function(...)
			local parts = {}
			for index = 1, select("#", ...) do
				table.insert(parts, stringify((select(index, ...))))
			end
			local text = table.concat(parts, " ")
			if run.bytes + #text > MAX_OUTPUT_BYTES then
				run.dropped += 1
				return
			end
			run.bytes += #text
			table.insert(run.output, { level = level, text = text })
		end
	end

	local function settle(run: Run, status: string, payload: any)
		if run.status ~= "running" then
			return
		end
		run.status = status
		if status == "done" then
			run.returns = payload
		else
			run.err = tostring(payload)
		end
		local waiter = run.waiter
		run.waiter = nil
		if waiter ~= nil then
			task.defer(waiter)
		end
	end

	-- Replies cross the VM boundary as one JSON string: Bindable marshalling
	-- drops mixed tables and nil holes that the encoded values may contain.
	local function reply(run: Run): string
		return HttpService:JSONEncode({
			status = run.status,
			output = run.output,
			dropped = run.dropped,
			returns = run.returns,
			err = run.err,
		})
	end

	local function exec(id: string, gen: number, module: ModuleScript): string
		local run: Run = { status = "running", output = {}, bytes = 0, dropped = 0 }
		local state = arm(id)
		local context = {
			id = id,
			gen = gen,
			alive = function(): boolean
				return not state.cancelled
			end,
			delay = function(seconds: number, fn: (...any) -> ...any, ...: any): thread
				return task.delay(seconds, function(...)
					if not state.cancelled then
						fn(...)
					end
				end, ...)
			end,
		}

		local clone = module:Clone()
		clone.Parent = host
		local loaded, entry = pcall(require, clone)
		clone:Destroy()
		if not loaded or type(entry) ~= "function" then
			settle(run, "error", "compile error: " .. tostring(entry))
			return reply(run)
		end

		-- A cancel can arrive while require() compiles the module.
		if state.cancelled then
			settle(run, "cancelled", "cancelled by request")
			return reply(run)
		end
		running[id] = run
		run.thread = task.spawn(function()
			local results = table.pack(xpcall(entry, function(err: any): string
				return tostring(err) .. "\n" .. debug.traceback(nil, 2)
			end, emitter(run, "info"), emitter(run, "warn"), context))
			if not results[1] then
				settle(run, "error", results[2])
				return
			end
			local returns = {}
			for index = 2, results.n do
				table.insert(returns, encodeValue(results[index]))
			end
			settle(run, "done", returns)
		end)
		if run.status == "running" then
			run.waiter = coroutine.running()
			coroutine.yield()
		end
		running[id] = nil
		return reply(run)
	end

	local function cancel(id: string)
		local state = armed[id]
		if state ~= nil then
			state.cancelled = true
			armed[id] = nil
		end
		local run = running[id]
		if run == nil or run.status ~= "running" then
			return
		end
		local thread = run.thread
		settle(run, "cancelled", "cancelled by request")
		if thread ~= nil then
			pcall(task.cancel, thread)
		end
	end

	invoke.OnInvoke = function(message: any): any
		if type(message) ~= "table" then
			return nil
		end
		local id = tostring(message.id)
		if message.kind == "exec" then
			return exec(id, tonumber(message.gen) or 0, message.module)
		elseif message.kind == "peek" then
			local run = running[id]
			return if run ~= nil then reply(run) else HttpService:JSONEncode({ status = "unknown" })
		elseif message.kind == "cancel" then
			cancel(id)
			return true
		end
		return nil
	end
	host:SetAttribute("Ready", true)
end
