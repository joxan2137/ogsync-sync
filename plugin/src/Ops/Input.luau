--!strict
-- input.batch: VirtualInputManager key/click/move/scroll plus Humanoid pathfinding nav; device/network emulation is Studio-UI only.
-- Clicks resolve their target at runtime and report what they actually hit.

local GuiService = game:GetService("GuiService")
local PathfindingService = game:GetService("PathfindingService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")

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

-- VirtualInputManager calls can be refused (security level, missing viewport);
-- that must surface as "unsupported", never as an ack for input that went nowhere.
local function send(vim: any, method: string, ...: any)
	local args = table.pack(...)
	local ok, err = pcall(function()
		vim[method](vim, table.unpack(args, 1, args.n))
	end)
	if not ok then
		error(string.format("input unsupported: VirtualInputManager:%s was refused (%s)", method, tostring(err)), 0)
	end
end

local function sendKey(vim: any, action: any)
	requireRunning("key")
	local code = keyCode(action.code)
	local hold = math.max(tonumber(action.hold_ms) or HOLD_MS_DEFAULT, 0)
	send(vim, "SendKeyEvent", true, code, false, game)
	task.wait(hold / 1000)
	send(vim, "SendKeyEvent", false, code, false, game)
end

local function guiInset(): Vector2
	local ok, inset = pcall(function()
		return GuiService:GetGuiInset()
	end)
	return if ok and typeof(inset) == "Vector2" then inset else Vector2.zero
end

local function guiShown(object: GuiObject): (boolean, string?)
	local current: Instance? = object
	while current ~= nil do
		if current:IsA("GuiObject") and not current.Visible then
			return false, Path.of(current) .. " is not Visible"
		elseif current:IsA("LayerCollector") then
			if not current.Enabled then
				return false, Path.of(current) .. " is disabled"
			end
			return current:IsA("ScreenGui") and current:IsDescendantOf(Players), "not under a ScreenGui in PlayerGui"
		end
		current = current.Parent
	end
	return false, "not under a ScreenGui"
end

-- Viewport (input) coordinates of what `path` names. GuiObject.AbsolutePosition
-- is measured below the top-bar inset, input coordinates are not, so the inset
-- is added here at click time instead of guessed from a screenshot.
local function pointOf(pathValue: string): (number, number, Instance)
	local inst, err = Path.resolve(pathValue)
	if not inst then
		error(err or ("no instance at " .. pathValue), 0)
	end
	if inst:IsA("ClickDetector") or inst:FindFirstChildOfClass("ClickDetector") then
		error(
			"click unsupported: synthetic clicks do not fire ClickDetector.MouseClick or MouseHoverEnter; call the handler through `run` instead",
			0
		)
	end
	if inst:IsA("GuiObject") then
		local shown, why = guiShown(inst)
		if not shown then
			error("click unsupported: " .. pathValue .. " is not on screen (" .. tostring(why) .. ")", 0)
		end
		local center = inst.AbsolutePosition + inst.AbsoluteSize / 2 + guiInset()
		return center.X, center.Y, inst
	end
	local world: Vector3? = nil
	if inst:IsA("BasePart") then
		world = inst.Position
	elseif inst:IsA("Model") then
		world = inst:GetPivot().Position
	elseif inst:IsA("Attachment") then
		world = inst.WorldPosition
	end
	local camera = Workspace.CurrentCamera
	if world == nil or camera == nil then
		error("click target " .. pathValue .. " (" .. inst.ClassName .. ") has no screen position", 0)
	end
	local point, onScreen = camera:WorldToViewportPoint(world)
	if not onScreen then
		error("click unsupported: " .. pathValue .. " is off screen or behind the camera", 0)
	end
	return point.X, point.Y, inst
end

-- What a click at (x, y) actually lands on: the topmost GuiObject, else the
-- part under the cursor.
local function hitAt(x: number, y: number): (Instance?, string?)
	local player = Players.LocalPlayer
	local playerGui = if player then player:FindFirstChildOfClass("PlayerGui") else nil
	if playerGui ~= nil then
		local inset = guiInset()
		local ok, objects = pcall(function()
			return playerGui:GetGuiObjectsAtPosition(x - inset.X, y - inset.Y)
		end)
		if ok and objects[1] ~= nil then
			return objects[1], "gui"
		end
	end
	local camera = Workspace.CurrentCamera
	if camera ~= nil then
		local ray = camera:ViewportPointToRay(x, y)
		local result = Workspace:Raycast(ray.Origin, ray.Direction * 5000)
		if result ~= nil then
			return result.Instance, "world"
		end
	end
	return nil, nil
end

local function sendClick(vim: any, action: any): any
	requireRunning("click")
	local x: number?, y: number?, target: Instance? = nil, nil, nil
	if type(action.path) == "string" then
		x, y, target = pointOf(action.path)
	else
		x, y = tonumber(action.x), tonumber(action.y)
	end
	if not x or not y then
		error("click action needs path or x and y")
	end
	local camera = Workspace.CurrentCamera
	if camera ~= nil and (x < 0 or y < 0 or x > camera.ViewportSize.X or y > camera.ViewportSize.Y) then
		error(string.format("click unsupported: (%d, %d) is outside the %dx%d viewport", x, y, camera.ViewportSize.X, camera.ViewportSize.Y), 0)
	end

	local fired = false
	local connection: RBXScriptConnection? = nil
	if target ~= nil and target:IsA("GuiButton") then
		connection = target.Activated:Connect(function()
			fired = true
		end)
	end
	local BUTTONS = { left = 0, right = 1, middle = 2 }
	local button = BUTTONS[tostring(action.button)] or tonumber(action.button) or 0
	-- Hover first: buttons that react to MouseEnter never see a teleporting cursor.
	send(vim, "SendMouseMoveEvent", x, y, game)
	-- Hit-test what the press lands on, before the click can hide or move it.
	local hit, layer = hitAt(x, y)
	send(vim, "SendMouseButtonEvent", x, y, button, true, game, 0)
	task.wait(0.03)
	send(vim, "SendMouseButtonEvent", x, y, button, false, game, 0)
	lastMouseX, lastMouseY = x, y
	if connection ~= nil then
		task.wait(0.1)
		connection:Disconnect()
	end

	local ack: any = { x = math.floor(x + 0.5), y = math.floor(y + 0.5), hit = if hit then Path.of(hit) else nil, layer = layer }
	if target ~= nil then
		ack.reached = hit ~= nil and (hit == target or hit:IsDescendantOf(target))
		if connection ~= nil then
			ack.activated = fired
		end
	end
	return ack
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
		send(vim, "SendMouseMoveEvent", fromX + (x - fromX) * alpha, fromY + (y - fromY) * alpha, game)
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
		send(vim, "SendMouseWheelEvent", x, y, forward, game)
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
					return sendClick(virtualInput(), action)
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
