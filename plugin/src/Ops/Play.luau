--!strict
-- play.start/stop/status: RunService run-mode control; play-solo is attempted then honestly degraded.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

type Register = (string, (any) -> any) -> ()

-- No public plugin API starts play-solo; probe the plugin-security candidates,
-- then fall back to run mode and report the degradation.
local SOLO_ATTEMPTS: { { service: string, method: string } } = {
	{ service = "PlaySoloService", method = "StartPlaySolo" },
	{ service = "StudioService", method = "PlaySolo" },
	{ service = "RunService", method = "Play" },
}

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
		return "edit"
	end
	if RunService:IsServer() and RunService:IsClient() then
		return if #Players:GetPlayers() > 0 then "solo" else "run"
	end
	return if RunService:IsServer() then "server" else "client"
end

return function(register: Register)
	register("play.start", function(args: any): any
		if RunService:IsRunning() then
			error("a playtest is already running in this session (mode " .. currentMode() .. ")")
		end
		local mode = args.mode or "solo"
		if mode ~= "solo" and mode ~= "server" then
			error("unknown play mode '" .. tostring(mode) .. "' (solo|server)")
		end

		if mode == "solo" then
			local via = attemptSolo()
			if via then
				return { started = "solo", requested = "solo", via = via }
			end
		end

		local ok, err = pcall(function()
			RunService:Run()
		end)
		if not ok then
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
		if not RunService:IsRunning() then
			error("no playtest running in this session")
		end
		local ok, err = pcall(function()
			RunService:Stop()
		end)
		if not ok then
			error("cannot stop playtest: " .. tostring(err))
		end
		return { stopped = true, mode = currentMode() }
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
		return {
			running = running,
			mode = currentMode(),
			players = players,
			uptime = if running and uptimeOk then uptime else 0,
		}
	end)
end
