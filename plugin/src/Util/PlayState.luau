--!strict
-- Playtest state of this DataModel as the daemon should see it. Ops/Play
-- records intent (a start or stop in flight) and whether a StudioTestService
-- play test it launched is still active; Lifecycle reads it on every heartbeat
-- and pushes changes at once.

export type Snapshot = { state: string, mode: string? }

local PlayState = {}

local intent = "idle" -- "idle" | "starting" | "stopping"
local testActive = false
local listeners: { () -> () } = {}

local function changed()
	for _, listener in listeners do
		task.spawn(listener)
	end
end

function PlayState.setIntent(value: string)
	if intent ~= value then
		intent = value
		changed()
	end
end

function PlayState.setTestActive(active: boolean)
	if testActive ~= active then
		testActive = active
		if not active and intent == "stopping" then
			intent = "idle"
		end
		changed()
	end
end

function PlayState.testActive(): boolean
	return testActive
end

function PlayState.onChange(listener: () -> ()): () -> ()
	table.insert(listeners, listener)
	return function()
		local index = table.find(listeners, listener)
		if index ~= nil then
			table.remove(listeners, index)
		end
	end
end

-- Pure: `running` is RunService:IsRunning() of this DataModel (Run mode
-- simulates in the edit DataModel itself).
function PlayState.derive(running: boolean, active: boolean, currentIntent: string): Snapshot
	local mode = if running then "run" elseif active then "play" else nil
	if running or active then
		return { state = if currentIntent == "stopping" then "stopping" else "running", mode = mode }
	end
	if currentIntent == "starting" or currentIntent == "stopping" then
		return { state = currentIntent, mode = nil }
	end
	return { state = "idle", mode = nil }
end

function PlayState.snapshot(running: boolean): Snapshot
	-- A finished start leaves nothing to wait for once the test is up or gone.
	if intent == "starting" and (running or testActive) then
		intent = "idle"
	end
	if intent == "stopping" and not running and not testActive then
		intent = "idle"
	end
	return PlayState.derive(running, testActive, intent)
end

return PlayState
