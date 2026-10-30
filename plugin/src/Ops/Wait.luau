--!strict
-- wait.check: one cheap probe of an instance or attribute. The daemon's `wait`
-- tool repeats it until the condition holds, so nothing here yields and a long
-- wait never holds Studio's main thread or the place's op queue.

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)
local Serde = require(Src.Util.Serde)

type Register = (string, (any) -> any) -> ()

local function sameValue(actual: any, expected: any): boolean
	if type(actual) == "number" and type(expected) == "number" then
		return math.abs(actual - expected) < 1e-9
	end
	return actual == expected
end

return function(register: Register)
	register("wait.check", function(args: any): any
		if type(args) ~= "table" or type(args.path) ~= "string" then
			error("BADARG: wait.check needs path", 0)
		end
		local inst = Path.resolve(args.path)
		if args.kind == "instance" then
			return { met = inst ~= nil, exists = inst ~= nil }
		end
		if args.kind ~= "attribute" then
			error("BADARG: wait.check kind must be instance or attribute", 0)
		end
		if type(args.name) ~= "string" then
			error("BADARG: wait.check attribute needs name", 0)
		end
		if inst == nil then
			return { met = false, exists = false }
		end
		local value = Serde.encode(inst:GetAttribute(args.name))
		local met = if args.value == nil then value ~= nil else sameValue(value, args.value)
		return { met = met, exists = true, value = value }
	end)
end
