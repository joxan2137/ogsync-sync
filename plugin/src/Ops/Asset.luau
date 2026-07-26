--!strict
-- asset.op: insert + details work from a plugin; search/library/thumbnail/upload have no plugin API and say so.

local InsertService = game:GetService("InsertService")
local MarketplaceService = game:GetService("MarketplaceService")
local Workspace = game:GetService("Workspace")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)

type Register = (string, (any) -> any) -> ()

local DESCRIPTION_CAP = 200

local function assetId(value: any): number
	local id = tonumber(value)
	if not id then
		error("asset id must be a number, got '" .. tostring(value) .. "'")
	end
	return math.floor(id)
end

local function insertAsset(args: any): any
	local id = assetId(args.id)
	local parent: Instance = Workspace
	if type(args.parent) == "string" then
		local resolved, err = Path.resolve(args.parent)
		if not resolved then
			error(err or ("no instance at " .. args.parent))
		end
		parent = resolved
	end

	local ok, container = pcall(function()
		return InsertService:LoadAsset(id)
	end)
	if not ok or not container then
		error("cannot insert asset " .. id .. ": " .. tostring(container))
	end

	local inserted = {}
	for _, child in container:GetChildren() do
		child.Parent = parent
		table.insert(inserted, Path.of(child))
	end
	container:Destroy()
	if #inserted == 0 then
		error("asset " .. id .. " loaded but contained no instances")
	end
	return { inserted = inserted, id = id }
end

local function assetDetails(args: any): any
	local ids = args.ids or args.id
	local list: { any } = if type(ids) == "table" then ids else { ids }
	local assets = {}
	local errors = {}
	for _, value in list do
		local ok, id = pcall(assetId, value)
		if not ok then
			table.insert(errors, { id = tostring(value), err = tostring(id) })
			continue
		end
		local infoOk, info = pcall(function()
			return MarketplaceService:GetProductInfo(id)
		end)
		if not infoOk or type(info) ~= "table" then
			table.insert(errors, { id = id, err = tostring(info) })
			continue
		end
		local creator = if type(info.Creator) == "table" then info.Creator.Name else nil
		table.insert(assets, {
			id = id,
			name = info.Name,
			creator = creator,
			assetTypeId = info.AssetTypeId,
			description = if type(info.Description) == "string"
				then string.sub(info.Description, 1, DESCRIPTION_CAP)
				else nil,
			created = info.Created,
			updated = info.Updated,
		})
	end
	return { assets = assets, errors = errors }
end

return function(register: Register)
	register("asset.op", function(args: any): any
		local op = args.op
		if op == "insert" then
			return insertAsset(args)
		elseif op == "details" then
			return assetDetails(args)
		elseif op == "search" then
			error("creator store search is unavailable to plugins — pass an asset id to asset.op insert/details")
		elseif op == "library" then
			error("creator store library browsing is unavailable to plugins — pass an asset id to asset.op insert")
		elseif op == "thumbnail" then
			error("asset thumbnails need a web fetch — the daemon must resolve them, not the plugin")
		elseif op == "upload" then
			error("asset upload requires an Open Cloud API key — not supported in plugin v1")
		end
		error("unknown asset op '" .. tostring(op) .. "' (insert|details|search|library|thumbnail|upload)")
	end)
end
