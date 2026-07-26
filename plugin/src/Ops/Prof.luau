--!strict
-- prof.memory (Stats tags), prof.script (ScriptProfilerService best-effort), prof.micro (no plugin API — errors).

local HttpService = game:GetService("HttpService")
local Stats = game:GetService("Stats")

type Register = (string, (any) -> any) -> ()

local TOP_DEFAULT = 25
local MAX_DURATION_S = 15
local MAX_WALK_DEPTH = 12

local START_METHODS = { "Start", "StartProfiling", "StartScriptProfiling" }
local DATA_METHODS = { "GetProfilingData", "GetData", "GetProfilerData" }
local STOP_METHODS = { "Stop", "StopProfiling", "StopScriptProfiling" }

local NAME_KEYS = { "Name", "name", "Function", "Source" }
local TIME_KEYS = { "TotalDuration", "SelfTime", "Duration", "duration", "ms", "TotalTime" }

local function call(service: any, methods: { string }, ...): (boolean, any)
	local packed = table.pack(...)
	for _, method in methods do
		if type(service[method]) ~= "function" then
			continue
		end
		local ok, result = pcall(service[method], service, table.unpack(packed, 1, packed.n))
		if ok then
			return true, result
		end
		local bare, bareResult = pcall(service[method], service)
		if bare then
			return true, bareResult
		end
	end
	return false, nil
end

local function firstField(node: any, keys: { string }): any
	for _, key in keys do
		local value = node[key]
		if value ~= nil then
			return value
		end
	end
	return nil
end

local function collectNodes(node: any, totals: { [string]: number }, depth: number)
	if type(node) ~= "table" or depth > MAX_WALK_DEPTH then
		return
	end
	local name = firstField(node, NAME_KEYS)
	local ms = tonumber(firstField(node, TIME_KEYS))
	if type(name) == "string" and ms then
		totals[name] = (totals[name] or 0) + ms
	end
	for _, child in pairs(node) do
		if type(child) == "table" then
			collectNodes(child, totals, depth + 1)
		end
	end
end

return function(register: Register)
	register("prof.memory", function(args: any): any
		local totalOk, total = pcall(function()
			return Stats:GetTotalMemoryUsageMb()
		end)
		if not totalOk then
			error("memory stats unavailable: " .. tostring(total))
		end
		local tags = {}
		for _, tag in Enum.DeveloperMemoryTag:GetEnumItems() do
			local ok, mb = pcall(function()
				return Stats:GetMemoryUsageMbForTag(tag)
			end)
			if ok and type(mb) == "number" and mb > 0 then
				table.insert(tags, { tag = tag.Name, mb = mb })
			end
		end
		table.sort(tags, function(a, b)
			return a.mb > b.mb
		end)
		local top = math.max(tonumber(args.top) or TOP_DEFAULT, 1)
		while #tags > top do
			table.remove(tags)
		end
		return { total_mb = total, tags = tags }
	end)

	register("prof.script", function(args: any): any
		local serviceOk, service = pcall(function()
			return game:GetService("ScriptProfilerService")
		end)
		if not serviceOk or not service then
			error("script profiling unsupported: no ScriptProfilerService in this Studio build")
		end
		local duration = math.clamp(tonumber(args.duration_s) or 5, 1, MAX_DURATION_S)
		local top = math.max(tonumber(args.top) or TOP_DEFAULT, 1)

		local started = call(service, START_METHODS, 1000)
		if not started then
			error("script profiling unsupported: ScriptProfilerService could not be started (plugin security)")
		end
		task.wait(duration)
		local gotData, data = call(service, DATA_METHODS)
		call(service, STOP_METHODS)
		if not gotData or data == nil then
			error("script profiling unsupported: profiler returned no data")
		end

		if type(data) == "string" then
			local decodeOk, decoded = pcall(function()
				return HttpService:JSONDecode(data)
			end)
			if not decodeOk then
				error("script profiling unsupported: profiler payload is not JSON")
			end
			data = decoded
		end

		local totals: { [string]: number } = {}
		collectNodes(data, totals, 0)
		local functions = {}
		local sum = 0
		for name, ms in pairs(totals) do
			sum += ms
			table.insert(functions, { name = name, ms = ms })
		end
		if #functions == 0 then
			error("script profiling unsupported: profiler payload has no recognizable function nodes")
		end
		table.sort(functions, function(a, b)
			return a.ms > b.ms
		end)
		while #functions > top do
			table.remove(functions)
		end
		for _, entry in functions do
			entry.pct = if sum > 0 then entry.ms / sum * 100 else 0
		end
		return { duration_s = duration, total_ms = sum, functions = functions }
	end)

	register("prof.micro", function(_args: any): any
		local candidates = { "MicroProfilerService", "DebuggerManager", "CaptureService" }
		for _, name in candidates do
			local ok, service = pcall(function()
				return game:GetService(name :: any)
			end)
			if ok and service then
				local capture = (service :: any).CaptureMicroProfiler or (service :: any).SaveMicroProfilerCapture
				if type(capture) == "function" then
					local captureOk, result = pcall(capture, service)
					if captureOk then
						return { service = name, capture = tostring(result) }
					end
				end
			end
		end
		error("microprofiler capture unsupported — use prof.script")
	end)
end
