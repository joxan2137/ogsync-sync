--!strict
-- Pushes this DataModel's playtest state to the daemon: at once on a change,
-- and every heartbeat so the daemon can tell a live "idle" from a wedged or
-- vanished plugin (no heartbeat reads "unknown", and hooks fail closed).

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local PlayState = require(script.Parent.Util.PlayState)

local HEARTBEAT_SECONDS = 5
local CHANGE_POLL_SECONDS = 1

export type Config = { role: string, pushEvent: (ev: any) -> () }

local Lifecycle = {}

local current: Config? = nil
local generation = 0
local lastKey: string? = nil

local function stateEvent(role: string): { [string]: any }
	if role == "edit" then
		local snapshot = PlayState.snapshot(RunService:IsRunning())
		return { ev = "playtestState", state = snapshot.state, mode = snapshot.mode, hb = true }
	end
	return { ev = "playtestState", state = "running", mode = "play", players = #Players:GetPlayers(), hb = true }
end

local function report(force: boolean)
	local config = current
	if config == nil then
		return
	end
	local ev = stateEvent(config.role)
	local key = string.format("%s|%s|%s", ev.state, tostring(ev.mode), tostring(ev.players))
	if force or key ~= lastKey then
		lastKey = key
		config.pushEvent(ev)
	end
end

function Lifecycle.start(config: Config): () -> ()
	current = config
	generation += 1
	local gen = generation
	local unsubscribe = PlayState.onChange(function()
		report(false)
	end)
	task.spawn(function()
		local sinceBeat = 0
		while generation == gen do
			task.wait(CHANGE_POLL_SECONDS)
			if generation ~= gen then
				break
			end
			sinceBeat += CHANGE_POLL_SECONDS
			local beat = sinceBeat >= HEARTBEAT_SECONDS
			if beat then
				sinceBeat = 0
			end
			report(beat)
		end
	end)
	return function()
		generation += 1
		unsubscribe()
		current = nil
	end
end

-- A fresh handshake means the daemon holds no state for this peer yet.
function Lifecycle.connected()
	report(true)
end

return Lifecycle
