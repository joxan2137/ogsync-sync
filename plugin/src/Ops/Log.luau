--!strict
-- log.tail over a 2000-entry ring buffer fed by LogService, plus rate-limited log event forwarding.

local LogService = game:GetService("LogService")
local RunService = game:GetService("RunService")

local Src = script.Parent.Parent :: any
local Output = require(Src.Util.Output)

type Register = (string, (any) -> any) -> ()

type Entry = { s: number, t: number, l: string, m: string }

local CAPACITY = 2000
local LIMIT_DEFAULT = 100
local EVENTS_PER_SECOND = 20

local LEVEL_RANK: { [string]: number } = { info = 1, warn = 2, error = 3 }

local buffer: { Entry } = table.create(CAPACITY)
local written = 0

local windowStart = 0
local windowCount = 0
local windowDropped = 0

local function context(): string
	if not RunService:IsRunning() then
		return "edit"
	end
	return if RunService:IsServer() then "server" else "client"
end

local function levelOf(messageType: Enum.MessageType): string
	if messageType == Enum.MessageType.MessageWarning then
		return "warn"
	elseif messageType == Enum.MessageType.MessageError then
		return "error"
	end
	return "info"
end

local net: any = nil

local function pushEvent(event: any)
	if not net then
		local ok, module = pcall(function()
			return require(Src.Net)
		end)
		if not ok or type(module) ~= "table" or type(module.pushEvent) ~= "function" then
			return
		end
		net = module
	end
	pcall(function()
		net.pushEvent(event)
	end)
end

local function forward(entry: Entry)
	local second = math.floor(os.clock())
	if second ~= windowStart then
		windowStart = second
		windowCount = 0
		if windowDropped > 0 then
			local dropped = windowDropped
			windowDropped = 0
			pushEvent({
				ev = "log",
				ctx = context(),
				level = "warn",
				msg = "[ogsync] dropped " .. dropped .. " log lines (rate limit)",
				ts = entry.t,
			})
		end
	end
	if windowCount >= EVENTS_PER_SECOND then
		windowDropped += 1
		return
	end
	windowCount += 1
	pushEvent({ ev = "log", ctx = context(), level = entry.l, msg = entry.m, ts = entry.t })
end

local function record(message: string, messageType: Enum.MessageType)
	written += 1
	local entry: Entry = {
		s = written,
		t = DateTime.now().UnixTimestampMillis,
		l = levelOf(messageType),
		m = message,
	}
	buffer[(written - 1) % CAPACITY + 1] = entry
	forward(entry)
end

local function matchesPattern(message: string, pattern: string): boolean
	local ok, found = pcall(string.find, message, pattern)
	if ok then
		return found ~= nil
	end
	return string.find(message, pattern, 1, true) ~= nil
end

return function(register: Register)
	local connected = pcall(function()
		LogService.MessageOut:Connect(record)
	end)
	if not connected then
		record("[ogsync] LogService.MessageOut unavailable — log.tail will stay empty", Enum.MessageType.MessageWarning)
	end

	register("log.tail", function(args: any): any
		local minRank = LEVEL_RANK[args.level] or 1
		local pattern = if type(args.pattern) == "string" then args.pattern else nil
		local since = tonumber(args.since) or 0
		local limit = math.max(tonumber(args.limit) or LIMIT_DEFAULT, 1)

		local matched: { Entry } = {}
		local oldest = math.max(written - CAPACITY + 1, 1)
		for seq = math.max(oldest, since + 1), written do
			local entry = buffer[(seq - 1) % CAPACITY + 1]
			if not entry then
				continue
			end
			if (LEVEL_RANK[entry.l] or 1) < minRank then
				continue
			end
			if pattern and not matchesPattern(entry.m, pattern) then
				continue
			end
			table.insert(matched, entry)
		end

		local selected: { Entry } = matched
		if since == 0 and #matched > limit then
			selected = {}
			for index = #matched - limit + 1, #matched do
				table.insert(selected, matched[index])
			end
		elseif #matched > limit then
			selected = {}
			for index = 1, limit do
				table.insert(selected, matched[index])
			end
		end

		local entries = {}
		local cursor = since
		for _, entry in selected do
			table.insert(entries, { t = entry.t, l = entry.l, m = entry.m })
			cursor = entry.s
		end
		if #selected == 0 then
			cursor = written
		end

		local list, truncated, total = Output.capList(entries)
		return {
			ctx = context(),
			entries = list,
			cursor = cursor,
			truncated = truncated,
			total = total,
			pending = written - cursor,
			dropped = windowDropped,
		}
	end)
end
