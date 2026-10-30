--!strict
-- Play-mode bridge. Client DataModels cannot use HttpService even at plugin
-- security, so the play-server session relays client-context jobs over
-- ReplicatedStorage.__OGSyncBroker and forwards client events to the daemon.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Dispatcher = require(script.Parent.Dispatcher)
local Net = require(script.Parent.Net)

local REMOTE_NAME = "__OGSyncBroker"
-- Used when a job carries no deadline; otherwise the client gets the daemon's
-- call timeout minus a margin for the relay back, so long client evals and
-- nav actions are not cut off at a fixed 10 s.
local DEFAULT_INVOKE_TIMEOUT = 10
local MIN_INVOKE_TIMEOUT = 1
local MAX_INVOKE_TIMEOUT = 600
local RELAY_MARGIN = 1
local REMOTE_WAIT = 10

local Broker = {}

local remote: RemoteFunction? = nil
local ownsRemote = false
local mode: string? = nil

local function ensureRemote(): RemoteFunction
	local existing = remote
	if existing ~= nil and existing.Parent ~= nil then
		return existing
	end
	local found = ReplicatedStorage:FindFirstChild(REMOTE_NAME)
	if found ~= nil and found:IsA("RemoteFunction") then
		remote = found
		ownsRemote = false
		return found
	end
	local created = Instance.new("RemoteFunction")
	created.Name = REMOTE_NAME
	created.Parent = ReplicatedStorage
	remote = created
	ownsRemote = true
	return created
end

function Broker.resolvePlayer(spec: any): Player?
	local players = Players:GetPlayers()
	if spec == nil then
		return players[1]
	end
	if typeof(spec) == "Instance" then
		local inst = spec :: Instance
		return if inst:IsA("Player") then inst else nil
	end
	if type(spec) == "number" then
		return players[spec]
	end
	if type(spec) == "string" then
		local byName = Players:FindFirstChild(spec)
		if byName ~= nil and byName:IsA("Player") then
			return byName
		end
		local index = tonumber(spec)
		if index ~= nil then
			return players[index]
		end
	end
	return nil
end

function Broker.startHost()
	mode = "host"
	local rf = ensureRemote()
	rf.OnServerInvoke = function(player: Player, message: any): any
		if type(message) ~= "table" then
			return { ok = false, err = "bad broker message" }
		end
		local incoming = message :: any
		if incoming.kind == "event" then
			if type(incoming.ev) == "table" then
				local ev = incoming.ev :: any
				if ev.ctx == nil then
					ev.ctx = "client"
				end
				Net.pushEvent(ev)
			end
			return { ok = true }
		elseif incoming.kind == "partial" then
			if type(incoming.id) == "string" then
				Net.pushPartial(incoming.id, incoming.data)
			end
			return { ok = true }
		end
		return { ok = false, err = string.format("unknown broker message kind '%s'", tostring(incoming.kind)) }
	end
end

function Broker.startClient()
	if mode == "client" then
		return
	end
	mode = "client"
	task.spawn(function()
		while mode == "client" do
			local found = ReplicatedStorage:WaitForChild(REMOTE_NAME, REMOTE_WAIT)
			if found ~= nil and found:IsA("RemoteFunction") then
				remote = found
				found.OnClientInvoke = function(message: any): any
					if type(message) ~= "table" or type((message :: any).op) ~= "string" then
						return { ok = false, err = "bad broker job" }
					end
					local incoming = message :: any
					return Dispatcher.dispatch({
						id = if type(incoming.id) == "string" then incoming.id else "broker",
						op = incoming.op,
						args = incoming.args,
					})
				end
				return
			end
		end
	end)
end

function Broker.invokeTimeout(job: any): number
	local deadline = if type(job) == "table" then tonumber(job.timeoutMs) else nil
	if deadline == nil then
		return DEFAULT_INVOKE_TIMEOUT
	end
	return math.clamp(deadline / 1000 - RELAY_MARGIN, MIN_INVOKE_TIMEOUT, MAX_INVOKE_TIMEOUT)
end

-- Blocks the calling job thread until the client answers or the timeout wins.
function Broker.toClient(job: any): any
	local args = if type(job.args) == "table" then job.args :: any else {}
	local player = Broker.resolvePlayer(args.player)
	if player == nil then
		return { ok = false, err = "no play-mode client to route to" }
	end
	local rf = ensureRemote()
	local thread = coroutine.running()
	local settled = false
	local function settle(value: any)
		if settled then
			return
		end
		settled = true
		task.defer(thread, value)
	end

	task.spawn(function()
		local ok, result = pcall(function(): any
			return rf:InvokeClient(player, { id = job.id, op = job.op, args = args })
		end)
		settle(if ok then result else { ok = false, err = tostring(result) })
	end)
	local timeout = Broker.invokeTimeout(job)
	task.delay(timeout, function()
		settle({ ok = false, err = string.format("client did not answer within %gs", timeout) })
	end)

	return coroutine.yield()
end

-- Client role has no HTTP: events reach the daemon through the play server.
function Broker.pushFromClient(ev: any)
	local rf = ReplicatedStorage:FindFirstChild(REMOTE_NAME)
	if rf == nil or not rf:IsA("RemoteFunction") then
		return
	end
	pcall(function()
		(rf :: RemoteFunction):InvokeServer({ kind = "event", ev = ev })
	end)
end

function Broker.stop()
	local rf = remote
	if rf ~= nil then
		if mode == "client" then
			pcall(function()
				rf.OnClientInvoke = nil :: any
			end)
		elseif ownsRemote then
			pcall(function()
				rf:Destroy()
			end)
		else
			pcall(function()
				rf.OnServerInvoke = nil :: any
			end)
		end
	end
	remote = nil
	ownsRemote = false
	mode = nil
end

return Broker
