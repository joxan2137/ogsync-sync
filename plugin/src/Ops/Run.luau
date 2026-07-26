--!strict
-- run.exec: loadstring in a print/warn-capturing sandbox; client context is brokered by the play server.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local Src = script.Parent.Parent :: any
local Serde = require(Src.Util.Serde)
local Output = require(Src.Util.Output)

type Register = (string, (any) -> any) -> ()

local MAX_OUTPUT_BYTES = 100 * 1024
local ENCODE_DEPTH = 4

local luauLoad = loadstring
local setEnv = setfenv
local getEnv = getfenv

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

local function execute(code: any): any
	if type(code) ~= "string" then
		error("run.exec requires `code` as a string")
	end

	local output = {}
	local bytes = 0
	local dropped = 0

	local function emit(level: string, ...)
		local parts = {}
		for index = 1, select("#", ...) do
			table.insert(parts, stringify((select(index, ...))))
		end
		local text = table.concat(parts, " ")
		if bytes + #text > MAX_OUTPUT_BYTES then
			dropped += 1
			return
		end
		bytes += #text
		table.insert(output, { level = level, text = text })
	end

	local chunk, compileErr = luauLoad(code, "=ogsync.run")
	if not chunk then
		error("compile error: " .. tostring(compileErr))
	end

	local sandbox = {
		print = function(...)
			emit("info", ...)
		end,
		warn = function(...)
			emit("warn", ...)
		end,
		error = function(message: any, level: number?)
			emit("error", message)
			error(message, (level or 1) + 1)
		end,
	}
	setEnv(chunk, setmetatable(sandbox, { __index = getEnv(0) }))

	local results = table.pack(xpcall(chunk, function(err: any): string
		return tostring(err) .. "\n" .. debug.traceback(nil, 2)
	end))

	if not results[1] then
		local trailer = ""
		if #output > 0 then
			local lines = {}
			for _, entry in output do
				table.insert(lines, entry.text)
			end
			trailer = "\n--- output ---\n" .. table.concat(lines, "\n")
		end
		error(tostring(results[2]) .. trailer)
	end

	local returns = {}
	for index = 2, results.n do
		table.insert(returns, encodeValue(results[index]))
	end

	local list, truncated = Output.capList(output)
	return {
		output = list,
		returns = returns,
		truncated = truncated or dropped > 0,
		dropped = dropped,
	}
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

return function(register: Register)
	register("run.exec", function(args: any): any
		-- Dispatcher routes client jobs on `args.ctx`; the tool contract calls it
		-- `context` — accept either so neither spelling silently runs in edit.
		local context = args.context or args.ctx or "edit"
		if context == "edit" or context == "server" then
			if context == "server" and not RunService:IsRunning() then
				error("run.exec context=server requires an active playtest")
			end
			return execute(args.code)
		elseif context == "client" then
			if not RunService:IsRunning() then
				error("run.exec context=client requires an active playtest")
			end
			-- A client DataModel (and single-DataModel solo/run) *is* the client
			-- context, so run here instead of brokering the job back to ourselves.
			if RunService:IsClient() then
				return execute(args.code)
			end
			local result = broker().toClient({ op = "run.exec", args = args })
			if type(result) == "table" and (result :: any).ok == false then
				error(tostring((result :: any).err or "client execution failed"))
			end
			return if type(result) == "table" then (result :: any).data else result
		end
		error("unknown run context '" .. tostring(context) .. "' (edit|server|client)")
	end)
end
