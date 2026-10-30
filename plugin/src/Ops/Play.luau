--!strict
-- play.start/stop/status/hashes. Starts prefer StudioTestService (a real play
-- test, tracked until it ends), then the legacy play-solo probes, then run
-- mode, and say which one happened. Start and stop are idempotent: asking for
-- what is already true answers truthfully instead of erroring.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

local Src = script.Parent.Parent :: any
local PlayState = require(Src.Util.PlayState)
local ScriptHashes = require(Src.Util.ScriptHashes)

type Register = (string, (any) -> any) -> ()

-- ExecutePlayModeAsync blocks until the test ends; an unsupported or refused
-- call fails within a frame or two, so a short probe tells the two apart.
local LAUNCH_PROBE_SECONDS = 0.5

-- No public plugin API starts play-solo on older builds; probe the
-- plugin-security candidates, then fall back to run mode and report it.
local SOLO_ATTEMPTS: { { service: string, method: string } } = {
	{ service = "PlaySoloService", method = "StartPlaySolo" },
	{ service = "StudioService", method = "PlaySolo" },
	{ service = "RunService", method = "Play" },
}

local function studioTestService(): any
	local ok, service = pcall(function()
		return game:GetService("StudioTestService" :: any)
	end)
	return if ok then service else nil
end

-- Test args reach the play DataModels (StudioTestService:GetTestArgs) and
-- nothing persists in the place: the play server presents this token at its
-- handshake, so the daemon pairs it with this place even when an unsaved or
-- local-file place gives every play DataModel the generic name "Game".
local function launchPlayTest(launch: string): string?
	local service = studioTestService()
	if service == nil or type(service.ExecutePlayModeAsync) ~= "function" then
		return nil
	end
	local finished = false
	local failure: string? = nil
	PlayState.setTestActive(true)
	task.spawn(function()
		local ok, err = pcall(function()
			service:ExecutePlayModeAsync({ ogsyncLaunch = launch })
		end)
		finished = true
		failure = if ok then nil else tostring(err)
		PlayState.setTestActive(false)
	end)
	local waited = 0
	while not finished and waited < LAUNCH_PROBE_SECONDS do
		waited += task.wait()
	end
	if finished and failure ~= nil then
		return nil
	end
	return "StudioTestService:ExecutePlayModeAsync"
end

local function attemptSolo(): string?
	for _, attempt in SOLO_ATTEMPTS do
		local serviceOk, service = pcall(function()
			return game:GetService(attempt.service :: any)
		end)
		if not serviceOk or not service then
			continue
		end
		local method = (service :: any)[attempt.method]
		if type(method) ~= "function" then
			continue
		end
		local ok = pcall(method, service)
		if ok then
			return attempt.service .. ":" .. attempt.method
		end
	end
	return nil
end

local function currentMode(): string
	if not RunService:IsRunning() then
		return if PlayState.testActive() then "play" else "edit"
	end
	if RunService:IsServer() and RunService:IsClient() then
		return if #Players:GetPlayers() > 0 then "solo" else "run"
	end
	return if RunService:IsServer() then "server" else "client"
end

-- Inside a play DataModel EndTest ends the whole test; Run mode only knows Stop.
local function endTest(): string?
	local service = studioTestService()
	if service ~= nil and type(service.EndTest) == "function" then
		local ok = pcall(function()
			service:EndTest("ogsync")
		end)
		if ok then
			return "StudioTestService:EndTest"
		end
	end
	local ok = pcall(function()
		RunService:Stop()
	end)
	return if ok then "RunService:Stop" else nil
end

return function(register: Register)
	register("play.start", function(args: any): any
		if RunService:IsRunning() or PlayState.testActive() then
			return { already = true, mode = currentMode() }
		end
		local mode = args.mode or "solo"
		if mode ~= "solo" and mode ~= "server" then
			error("unknown play mode '" .. tostring(mode) .. "' (solo|server)")
		end
		PlayState.setIntent("starting")

		if mode == "solo" then
			local launch = HttpService:GenerateGUID(false)
			local via = launchPlayTest(launch)
			if via then
				return { started = "solo", requested = "solo", via = via, launch = launch }
			end
			via = attemptSolo()
			if via then
				return { started = "solo", requested = "solo", via = via }
			end
		end

		local ok, err = pcall(function()
			RunService:Run()
		end)
		if not ok then
			PlayState.setIntent("idle")
			error("cannot start playtest: " .. tostring(err))
		end
		if mode == "solo" then
			return {
				started = "run",
				requested = "solo",
				note = "play-solo has no plugin API in this Studio build — started run mode (no player character)",
			}
		end
		return { started = "server", requested = "server" }
	end)

	register("play.stop", function(_args: any): any
		if not RunService:IsRunning() and not PlayState.testActive() then
			return { stopped = false, mode = currentMode(), note = "no playtest running in this session" }
		end
		if not RunService:IsRunning() then
			-- The test runs in its own DataModels; only the play server's plugin
			-- can end it. NOPLUGIN makes the daemon fall back to play.stopSignal,
			-- which that plugin's stop monitor acts on.
			error("NOPLUGIN: the play test runs in its own DataModel; it ends through the play-server session", 0)
		end
		PlayState.setIntent("stopping")
		local via = endTest()
		if via == nil then
			PlayState.setIntent("idle")
			error("cannot stop playtest from this session; the daemon falls back to play.stopSignal")
		end
		return { stopped = true, mode = currentMode(), via = via }
	end)

	register("play.status", function(_args: any): any
		local players = {}
		for _, player in Players:GetPlayers() do
			table.insert(players, player.Name)
		end
		local running = RunService:IsRunning()
		local uptimeOk, uptime = pcall(function()
			return Workspace.DistributedGameTime
		end)
		local snapshot = PlayState.snapshot(running)
		return {
			running = running or PlayState.testActive(),
			state = snapshot.state,
			mode = currentMode(),
			players = players,
			uptime = if running and uptimeOk then uptime else 0,
		}
	end)

	-- Chunked across frames: a big place takes longer than Studio's plugin watchdog.
	register("play.hashes", function(_args: any): any
		return ScriptHashes.collect(game)
	end)
end
