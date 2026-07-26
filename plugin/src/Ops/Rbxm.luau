--!strict
-- rbxm.export/import: Studio exposes no plugin-side model serialization or byte loading, so both ops fail loudly.

type Register = (string, (any) -> any) -> ()

local EXPORT_MESSAGE = "rbxm export unsupported in the plugin — Studio has no plugin-callable SaveInstance; "
	.. "use the daemon's rojo build / Studio's own Save to File for now"
local IMPORT_MESSAGE = "rbxm import unsupported in the plugin — Studio cannot load model bytes from a string; "
	.. "use asset.op insert for marketplace assets, or create instances with inst.create"

return function(register: Register)
	register("rbxm.export", function(_args: any): any
		error(EXPORT_MESSAGE)
	end)

	register("rbxm.import", function(_args: any): any
		error(IMPORT_MESSAGE)
	end)
end
