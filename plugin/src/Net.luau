--!strict
-- Daemon transport (docs/PROTOCOL.md): handshake, long-poll pull, batched push.
-- The plugin is always the HTTP client and never runs in a play-mode client
-- DataModel (HttpService is unavailable there).

local HttpService = game:GetService("HttpService")

local Dispatcher = require(script.Parent.Dispatcher)
local Output = require(script.Parent.Util.Output)
local Version = require(script.Parent.Version)

local PROTO = 1
local HANDSHAKE_RETRY = 5
local BACKOFF_MIN = 1
local BACKOFF_MAX = 10
local BACKOFF_FACTOR = 1.5
local REJECT_RETRY = 1
local EVENT_FLUSH_DELAY = 0.3
local RESULT_FLUSH_DELAY = 0.05
local EVENT_FLUSH_COUNT = 50
local MAX_QUEUED_EVENTS = 500
local MAX_QUEUED_RESULTS = 200
local BODY_BUDGET = Output.MAX_BYTES - 4096

export type Config = { baseUrl: string, session: string, role: string }

export type Status = {
	connected: boolean,
	accepted: boolean,
	reason: string?,
	serverVersion: string?,
	syncEnabled: boolean,
	projectName: string?,
}

local Net = {}

local running = false
local accepted = false
local flushing = false
local generation = 0
local cursor = 0
local backoff = BACKOFF_MIN
local baseUrl = ""
local session = ""
local role = ""

local eventQueue: {any} = {}
local resultQueue: {any} = {}
local flushThread: thread? = nil
local flushDeadline: number? = nil

local state: Status = {
	connected = false,
	accepted = false,
	reason = nil,
	serverVersion = nil,
	syncEnabled = false,
	projectName = nil,
}

-- UI.setState, injected by init so the transport never requires the UI layer.
local observer: ((partial: {[string]: any}) -> ())? = nil

function Net.setObserver(fn: ((partial: {[string]: any}) -> ())?)
	observer = fn
end

local function notify(partial: {[string]: any})
	local fn = observer
	if fn ~= nil then
		pcall(fn, partial)
	end
end

local function resetBackoff()
	backoff = BACKOFF_MIN
end

local function nextBackoff(): number
	local wait = backoff
	backoff = math.min(backoff * BACKOFF_FACTOR, BACKOFF_MAX)
	return wait
end

local function request(method: string, url: string, body: any?): (number, any, string?)
	local options: {[string]: any} = { Url = url, Method = method }
	if body ~= nil then
		local okEncode, encoded = pcall(function(): string
			return HttpService:JSONEncode(body)
		end)
		if not okEncode then
			return 0, nil, "serialization failed: " .. tostring(encoded)
		end
		options.Body = encoded
		options.Headers = { ["Content-Type"] = "application/json" }
	end
	local okRequest, response = pcall(function(): any
		return HttpService:RequestAsync(options)
	end)
	if not okRequest then
		return 0, nil, tostring(response)
	end
	local decoded: any = nil
	local rawBody = (response :: any).Body
	if type(rawBody) == "string" and #rawBody > 0 then
		local okDecode, value = pcall(function(): any
			return HttpService:JSONDecode(rawBody)
		end)
		if okDecode then
			decoded = value
		end
	end
	return (response :: any).StatusCode, decoded, nil
end

-- ------------------------------------------------------------------ push side

local flushNow: () -> ()

local function scheduleFlush(delay: number)
	local at = os.clock() + delay
	if flushDeadline ~= nil and flushDeadline <= at then
		return
	end
	local pending = flushThread
	if pending then
		task.cancel(pending)
	end
	flushDeadline = at
	flushThread = task.delay(delay, function()
		flushThread = nil
		flushDeadline = nil
		flushNow()
	end)
end

local function takeBatch(queue: {any}, limit: number, budget: number): ({any}, number)
	local batch: {any} = {}
	while #queue > 0 and #batch < limit do
		local size = Output.jsonSize(queue[1])
		if size == nil then
			local dropped = table.remove(queue, 1)
			if type(dropped) == "table" and (dropped :: any).id ~= nil then
				table.insert(batch, {
					id = (dropped :: any).id,
					ok = false,
					err = "serialization failed: result is not JSON-encodable",
				})
			end
			continue
		end
		if #batch > 0 and size > budget then
			break
		end
		budget -= size
		table.insert(batch, table.remove(queue, 1))
	end
	return batch, budget
end

function flushNow()
	if flushing then
		scheduleFlush(RESULT_FLUSH_DELAY)
		return
	end
	if #resultQueue == 0 and #eventQueue == 0 then
		return
	end
	if not accepted then
		eventQueue = {}
		if #resultQueue > 0 then
			scheduleFlush(REJECT_RETRY)
		end
		return
	end

	local results, budget = takeBatch(resultQueue, MAX_QUEUED_RESULTS, BODY_BUDGET)
	local events = takeBatch(eventQueue, MAX_QUEUED_EVENTS, budget)
	if #results == 0 and #events == 0 then
		return
	end

	local payload: {[string]: any} = { session = session }
	if #results > 0 then
		payload.results = results
	end
	if #events > 0 then
		payload.events = events
	end

	flushing = true
	local status, _, err = request("POST", baseUrl .. "/push", payload)
	flushing = false

	if err ~= nil or status == 0 or status >= 400 then
		state.connected = false
		state.reason = err or string.format("push %d", status)
		-- Results are worth a retry; events are fire-and-forget per protocol.
		for index = #results, 1, -1 do
			if #resultQueue < MAX_QUEUED_RESULTS then
				table.insert(resultQueue, 1, results[index])
			end
		end
		if #resultQueue > 0 then
			scheduleFlush(nextBackoff())
		end
		return
	end

	state.connected = true
	resetBackoff()
	if #resultQueue > 0 or #eventQueue > 0 then
		scheduleFlush(RESULT_FLUSH_DELAY)
	end
end

function Net.pushEvent(ev: any)
	if not running or not accepted then
		return
	end
	table.insert(eventQueue, ev)
	while #eventQueue > MAX_QUEUED_EVENTS do
		table.remove(eventQueue, 1)
	end
	scheduleFlush(if #eventQueue >= EVENT_FLUSH_COUNT then 0 else EVENT_FLUSH_DELAY)
end

function Net.pushPartial(jobId: string, data: any)
	if not running then
		return
	end
	local capped, err = Output.capResult(data)
	local result: {[string]: any} = if err ~= nil
		then { id = jobId, ok = false, err = err, partial = true }
		else { id = jobId, ok = true, data = capped, partial = true }
	table.insert(resultQueue, result)
	scheduleFlush(0)
end

local function queueResult(result: any)
	table.insert(resultQueue, result)
	while #resultQueue > MAX_QUEUED_RESULTS do
		table.remove(resultQueue, 1)
	end
	scheduleFlush(RESULT_FLUSH_DELAY)
end

-- ------------------------------------------------------------------ pull side

local function runJob(job: any)
	if type(job) ~= "table" or type(job.id) ~= "string" then
		return
	end
	queueResult(Dispatcher.dispatch(job))
end

local function doHandshake(): boolean
	local status, body, err = request("POST", baseUrl .. "/handshake", {
		proto = PROTO,
		session = session,
		role = role,
		pluginVersion = Version,
		placeId = game.PlaceId,
		placeName = game.Name,
	})

	if err ~= nil or status == 0 then
		state.connected = false
		state.reason = err
		local retry = nextBackoff()
		notify({ status = "connecting", reason = state.reason, retryIn = retry })
		task.wait(retry)
		return true
	end
	if status ~= 200 or type(body) ~= "table" then
		state.connected = false
		state.reason = string.format("handshake %d", status)
		notify({ status = "connecting", reason = state.reason, retryIn = HANDSHAKE_RETRY })
		task.wait(HANDSHAKE_RETRY)
		return true
	end

	local response = body :: any
	if response.proto ~= PROTO then
		warn(string.format(
			"[OGSync] protocol mismatch: plugin speaks proto %d, daemon speaks %s — update the plugin",
			PROTO,
			tostring(response.proto)
		))
		state.reason = "protocol mismatch"
		state.connected = false
		running = false
		notify({
			status = "update",
			reason = string.format("daemon speaks proto %s, plugin speaks %d", tostring(response.proto), PROTO),
			serverVersion = response.serverVersion,
			updatePlugin = true,
			connected = false,
		})
		return false
	end

	state.serverVersion = response.serverVersion
	if response.accepted ~= true then
		accepted = false
		state.accepted = false
		state.connected = true
		state.reason = if type(response.reason) == "string" then response.reason else "not accepted"
		notify({
			status = "rejected",
			reason = state.reason,
			serverVersion = state.serverVersion,
			retryIn = HANDSHAKE_RETRY,
		})
		task.wait(HANDSHAKE_RETRY)
		return true
	end

	accepted = true
	state.accepted = true
	state.connected = true
	state.reason = nil
	state.syncEnabled = response.syncEnabled == true
	state.projectName = response.projectName
	resetBackoff()
	if response.updatePlugin == true then
		warn("[OGSync] daemon has a newer plugin build — reload plugins in Studio")
	end
	-- "" rather than nil: absent keys are skipped by the merge, so clearing a
	-- stale reason needs a present-but-empty value.
	notify({
		status = "connected",
		reason = "",
		serverVersion = state.serverVersion,
		projectName = state.projectName,
		syncEnabled = state.syncEnabled,
		updatePlugin = response.updatePlugin == true,
		connected = true,
	})
	return true
end

local function pullOnce()
	local status, body, err = request(
		"GET",
		string.format("%s/pull?session=%s&cursor=%d", baseUrl, session, cursor)
	)

	if err ~= nil or status == 0 then
		state.connected = false
		state.reason = err
		local retry = nextBackoff()
		notify({ status = "connecting", reason = state.reason, retryIn = retry })
		task.wait(retry)
		return
	end

	if status == 204 then
		if not state.connected then
			notify({ status = "connected", reason = "", connected = true })
		end
		state.connected = true
		state.reason = nil
		resetBackoff()
		return
	end

	if status == 200 then
		if not state.connected then
			notify({ status = "connected", reason = "", connected = true })
		end
		state.connected = true
		state.reason = nil
		resetBackoff()
		if type(body) == "table" then
			local response = body :: any
			if type(response.cursor) == "number" then
				cursor = response.cursor
			end
			if type(response.jobs) == "table" then
				for _, job in response.jobs :: {any} do
					task.spawn(runJob, job)
				end
			end
		end
		return
	end

	if status == 400 or status == 404 or status == 409 then
		-- Daemon no longer knows this session (restart or rebind): re-handshake.
		accepted = false
		state.accepted = false
		state.reason = if type(body) == "table" then tostring((body :: any).error) else string.format("pull %d", status)
		notify({ status = "connecting", reason = state.reason, retryIn = REJECT_RETRY })
		task.wait(REJECT_RETRY)
		return
	end

	state.connected = false
	state.reason = string.format("pull %d", status)
	local retry = nextBackoff()
	notify({ status = "connecting", reason = state.reason, retryIn = retry })
	task.wait(retry)
end

-- ------------------------------------------------------------------ lifecycle

function Net.start(config: Config)
	if running then
		return
	end
	running = true
	accepted = false
	cursor = 0
	baseUrl = config.baseUrl
	session = config.session
	role = config.role
	resetBackoff()
	eventQueue = {}
	resultQueue = {}
	state.accepted = false
	state.connected = false
	state.reason = nil
	notify({ status = "connecting", reason = "", connected = true, retryIn = HANDSHAKE_RETRY })

	generation += 1
	local gen = generation
	task.spawn(function()
		while running and generation == gen do
			if not accepted then
				if not doHandshake() then
					return
				end
			elseif running and generation == gen then
				pullOnce()
			end
		end
	end)
end

function Net.stop()
	running = false
	accepted = false
	generation += 1
	local pending = flushThread
	if pending then
		task.cancel(pending)
	end
	flushThread = nil
	flushDeadline = nil
	eventQueue = {}
	resultQueue = {}
	state.connected = false
	state.accepted = false
	state.reason = "stopped"
	notify({ status = "disconnected", reason = "", connected = false, syncEnabled = false })
end

function Net.isRunning(): boolean
	return running
end

function Net.status(): Status
	return table.clone(state)
end

return Net
