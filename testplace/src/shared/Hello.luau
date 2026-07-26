--!strict
local Hello = {}

function Hello.greet(name: string): string
	return "hello " .. name
end

return Hello
