--!strict
-- hist.op: ChangeHistoryService undo/redo/waypoint, reporting the waypoint name Studio acted on.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

type Register = (string, (any) -> any) -> ()

local function pendingName(getter: string): string?
	local ok, _, name = pcall(function()
		return (ChangeHistoryService :: any)[getter](ChangeHistoryService)
	end)
	return if ok and type(name) == "string" then name else nil
end

return function(register: Register)
	register("hist.op", function(args: any): any
		local op = args.op
		if op == "undo" then
			local name = pendingName("GetCanUndo")
			local ok, err = pcall(function()
				ChangeHistoryService:Undo()
			end)
			if not ok then
				error("undo failed: " .. tostring(err))
			end
			return { op = "undo", name = name }
		elseif op == "redo" then
			local name = pendingName("GetCanRedo")
			local ok, err = pcall(function()
				ChangeHistoryService:Redo()
			end)
			if not ok then
				error("redo failed: " .. tostring(err))
			end
			return { op = "redo", name = name }
		elseif op == "waypoint" then
			local name = if type(args.name) == "string" then args.name else "OGSync waypoint"
			local ok, err = pcall(function()
				ChangeHistoryService:SetWaypoint(name)
			end)
			if not ok then
				error("waypoint failed: " .. tostring(err))
			end
			return { op = "waypoint", name = name }
		end
		error("unknown history op '" .. tostring(op) .. "' (undo|redo|waypoint)")
	end)
end
