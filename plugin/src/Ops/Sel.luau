--!strict
-- sel.get plus selection events, pushed at most once a second.

local Selection = game:GetService("Selection")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)
local Output = require(Src.Util.Output)

type Register = (string, (any) -> any) -> ()

local PUSH_INTERVAL_S = 1

local net: any = nil
local lastPush = 0
local scheduled = false

local function selectionPaths(): { string }
	local ok, selected = pcall(function()
		return Selection:Get()
	end)
	if not ok then
		return {}
	end
	local paths = {}
	for _, inst in selected do
		table.insert(paths, Path.of(inst))
	end
	return paths
end

local function pushSelection()
	if not net then
		local ok, module = pcall(function()
			return require(Src.Net)
		end)
		if not ok or type(module) ~= "table" or type(module.pushEvent) ~= "function" then
			return
		end
		net = module
	end
	local paths = Output.capList(selectionPaths())
	pcall(function()
		net.pushEvent({ ev = "selection", paths = paths })
	end)
end

return function(register: Register)
	pcall(function()
		Selection.SelectionChanged:Connect(function()
			local now = os.clock()
			if now - lastPush >= PUSH_INTERVAL_S then
				lastPush = now
				pushSelection()
			elseif not scheduled then
				scheduled = true
				task.delay(PUSH_INTERVAL_S - (now - lastPush), function()
					scheduled = false
					lastPush = os.clock()
					pushSelection()
				end)
			end
		end)
	end)

	register("sel.get", function(_args: any): any
		local paths, truncated, total = Output.capList(selectionPaths())
		return { paths = paths, truncated = truncated, total = total }
	end)
end
