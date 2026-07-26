--!strict
-- input.batch: VirtualInputManager key/click/move/scroll plus Humanoid pathfinding nav; device/network emulation is Studio-UI only.

local PathfindingService = game:GetService("PathfindingService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)

type Register = (string, (any) -> any) -> ()

local HOLD_MS_DEFAULT = 60
local MOVE_STEP_MS = 16
local NAV_TIMEOUT_MS_DEFAULT = 15000
local NAV_WAYPOINT_TIMEOUT_S = 5

local lastMouseX = 0
local lastMouseY = 0

local function virtualInput(): any
	local ok, service = pcall(function()
		return game:GetService("VirtualInputManager")
	end)
	if not ok or not service then
		error("input unsupported: VirtualInputManager is not available in this session")
	end
	return service
end

local function requireRunning(kind: string)
	if not RunService:IsRunning() then
		error("input " .. kind .. " requires an active playtest")
	end
end

local function keyCode(name: any): Enum.KeyCode
	if type(name) ~= "string" then
		error("key action needs a `code` name, e.g. \"W\" or \"Space\"")
	end
	local ok, code = pcall(function()
		return (Enum.KeyCode :: any)[name]
	end)
	if not ok or not code then
		error("unknown key code '" .. name .. "'")
	end
	return code
end

local function sendKey(vim: any, action: any)
	requireRunning("key")
	local code = keyCode(action.code)
	local hold = math.max(tonumber(action.hold_ms) or HOLD_MS_DEFAULT, 0)
	vim:SendKeyEvent(true, code, false, game)
	task.wait(hold / 1000)
	vim:SendKeyEvent(false, code, false, game)
end

local function sendClick(vim: any, action: any)
	requireRunning("click")
	local x = tonumber(action.x)
	local y = tonumber(action.y)
	if not x or not y then
		error("click action needs x and y")
	end
	local BUTTONS = { left = 0, right = 1, middle = 2 }
	local button = BUTTONS[tostring(action.button)] or tonumber(action.button) or 0
	vim:SendMouseButtonEvent(x, y, button, true, game, 0)
	task.wait(0.03)
	vim:SendMouseButtonEvent(x, y, button, false, game, 0)
	lastMouseX, lastMouseY = x, y
end

local function sendMove(vim: any, action: any)
	local x = tonumber(action.x)
	local y = tonumber(action.y)
	if not x or not y then
		error("move action needs x and y")
	end
	local duration = math.max(tonumber(action.duration_ms) or 0, 0)
	local steps = math.max(math.floor(duration / MOVE_STEP_MS), 1)
	local fromX, fromY = lastMouseX, lastMouseY
	for step = 1, steps do
		local alpha = step / steps
		vim:SendMouseMoveEvent(fromX + (x - fromX) * alpha, fromY + (y - fromY) * alpha, game)
		if steps > 1 then
			task.wait(MOVE_STEP_MS / 1000)
		end
	end
	lastMouseX, lastMouseY = x, y
end

local function sendScroll(vim: any, action: any)
	local x = tonumber(action.x) or lastMouseX
	local y = tonumber(action.y) or lastMouseY
	local delta = tonumber(action.delta) or tonumber(action.amount) or 1
	local forward = delta > 0
	for _ = 1, math.min(math.abs(math.floor(delta)), 32) do
		vim:SendMouseWheelEvent(x, y, forward, game)
		task.wait(0.01)
	end
end

local function targetPosition(to: any): Vector3
	if type(to) == "table" then
		local x, y, z = tonumber(to[1]), tonumber(to[2]), tonumber(to[3])
		if not x or not y or not z then
			error("nav `to` array must be [x,y,z]")
		end
		return Vector3.new(x, y, z)
	end
	if type(to) ~= "string" then
		error("nav needs `to` as a path or [x,y,z]")
	end
	local inst, err = Path.resolve(to)
	if not inst then
		error(err or ("no instance at " .. to))
	end
	if inst:IsA("BasePart") then
		return inst.Position
	elseif inst:IsA("Model") then
		return inst:GetPivot().Position
	elseif inst:IsA("Attachment") then
		return inst.WorldPosition
	end
	error("nav target " .. to .. " (" .. inst.ClassName .. ") has no world position")
end

local function localHumanoid(): (Humanoid, BasePart)
	local player = Players.LocalPlayer
	if not player then
		local players = Players:GetPlayers()
		player = players[1]
	end
	if not player then
		error("nav needs a player character — start a playtest with a player first")
	end
	local character = player.Character
	local humanoid = if character then character:FindFirstChildOfClass("Humanoid") else nil
	local root = if character then character:FindFirstChild("HumanoidRootPart") else nil
	if not humanoid or not root or not root:IsA("BasePart") then
		error("nav needs a spawned character with a Humanoid")
	end
	return humanoid, root
end

local function navigate(action: any): any
	requireRunning("nav")
	local goal = targetPosition(action.to)
	local humanoid, root = localHumanoid()
	local timeout = math.max(tonumber(action.timeout_ms) or NAV_TIMEOUT_MS_DEFAULT, 100) / 1000
	local deadline = os.clock() + timeout

	local path = PathfindingService:CreatePath({ AgentCanJump = true })
	local computed, computeErr = pcall(function()
		path:ComputeAsync(root.Position, goal)
	end)
	if not computed then
		error("pathfinding failed: " .. tostring(computeErr))
	end
	if path.Status ~= Enum.PathStatus.Success then
		error("no path to target (" .. path.Status.Name .. ")")
	end

	for _, waypoint in path:GetWaypoints() do
		if os.clock() > deadline then
			break
		end
		if waypoint.Action == Enum.PathWaypointAction.Jump then
			humanoid.Jump = true
		end
		humanoid:MoveTo(waypoint.Position)
		local reachedWaypoint = false
		local connection = humanoid.MoveToFinished:Connect(function()
			reachedWaypoint = true
		end)
		local waypointDeadline = math.min(os.clock() + NAV_WAYPOINT_TIMEOUT_S, deadline)
		while not reachedWaypoint and os.clock() < waypointDeadline do
			task.wait(0.05)
		end
		connection:Disconnect()
	end

	local distance = (root.Position - goal).Magnitude
	return { reached = distance <= 6, dist = distance }
end

return function(register: Register)
	register("input.batch", function(args: any): any
		local actions = args.actions
		if type(actions) ~= "table" then
			error("input.batch requires an actions array")
		end
		local results = {}
		for _, action in actions do
			local kind = if type(action) == "table" then action.type else nil
			local ok, result = pcall(function(): any
				if kind == "key" then
					sendKey(virtualInput(), action)
					return { code = action.code }
				elseif kind == "click" then
					sendClick(virtualInput(), action)
					return { x = action.x, y = action.y }
				elseif kind == "move" then
					sendMove(virtualInput(), action)
					return { x = action.x, y = action.y }
				elseif kind == "scroll" then
					sendScroll(virtualInput(), action)
					return { delta = action.delta or action.amount }
				elseif kind == "nav" then
					return navigate(action)
				elseif kind == "device" then
					error("device emulation requires Studio UI — unsupported from a plugin")
				elseif kind == "network" then
					error("network throttling requires Studio UI — unsupported from a plugin")
				end
				error("unknown action type '" .. tostring(kind) .. "' (key|click|move|scroll|nav|device|network)")
			end)
			local entry: any = { type = kind, ok = ok }
			if ok then
				if type(result) == "table" then
					for key, value in pairs(result) do
						entry[key] = value
					end
				end
			else
				entry.err = tostring(result)
			end
			table.insert(results, entry)
		end
		return { actions = results }
	end)
end
