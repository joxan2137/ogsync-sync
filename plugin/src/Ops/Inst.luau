--!strict
-- inst.* ops: inspection (get/find/tree) and mutation (set/create/delete/duplicate); tree keys are 1-char (n,c,k,ln,ch) — the daemon renders them.

local CollectionService = game:GetService("CollectionService")
local RunService = game:GetService("RunService")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)
local Serde = require(Src.Util.Serde)
local Output = require(Src.Util.Output)
local Recording = require(Src.Util.Recording)
local Source = require(Src.Util.Source)
local Transform = require(Src.Util.Transform)

type Register = (string, (any) -> any) -> ()

local YIELD_EVERY = 2000
local INCOMING_SCAN_CAP = 20000
local TREE_NODE_CAP = 5000
local FIND_LIMIT_DEFAULT = 100

local BASE_PROPS = { "Name", "Archivable" }

local PART_PROPS = {
	"Anchored",
	"CanCollide",
	"CanTouch",
	"CastShadow",
	"CFrame",
	"CollisionGroup",
	"Color",
	"Massless",
	"Material",
	"Orientation",
	"Position",
	"Reflectance",
	"Size",
	"Transparency",
}
local TEXT_PROPS = {
	"Text",
	"TextColor3",
	"TextScaled",
	"TextSize",
	"TextTransparency",
	"TextWrapped",
	"TextXAlignment",
	"TextYAlignment",
	"RichText",
	"FontFace",
	"LineHeight",
	"TextStrokeColor3",
	"TextStrokeTransparency",
	"TextTruncate",
}
local IMAGE_PROPS = {
	"Image",
	"ImageColor3",
	"ImageRectOffset",
	"ImageRectSize",
	"ImageTransparency",
	"ResampleMode",
	"ScaleType",
	"SliceCenter",
	"SliceScale",
	"TileSize",
}
local LIGHT_PROPS = { "Brightness", "Color", "Enabled", "Shadows", "Range" }
local SURFACE_MAP_PROPS = { "ColorMap", "MetalnessMap", "NormalMap", "RoughnessMap" }

local PROP_SETS: { { class: string, props: { string } } } = {
	{ class = "BasePart", props = PART_PROPS },
	{ class = "Part", props = { "Shape" } },
	{ class = "MeshPart", props = { "MeshId", "TextureID", "DoubleSided", "RenderFidelity", "CollisionFidelity" } },
	{ class = "SpecialMesh", props = { "MeshId", "MeshType", "Offset", "Scale", "TextureId", "VertexColor" } },
	{ class = "Model", props = { "PrimaryPart", "WorldPivot", "LevelOfDetail", "ModelStreamingMode" } },
	{ class = "Folder", props = {} },
	{
		class = "Humanoid",
		props = {
			"AutoRotate",
			"DisplayName",
			"Health",
			"HipHeight",
			"JumpHeight",
			"JumpPower",
			"MaxHealth",
			"PlatformStand",
			"RigType",
			"Sit",
			"WalkSpeed",
		},
	},
	{ class = "Camera", props = { "CameraSubject", "CameraType", "CFrame", "FieldOfView", "Focus" } },
	{ class = "Light", props = LIGHT_PROPS },
	{ class = "SpotLight", props = { "Angle", "Face" } },
	{ class = "SurfaceLight", props = { "Angle", "Face" } },
	{ class = "Attachment", props = { "CFrame", "Orientation", "Position", "Visible", "WorldPosition" } },
	{ class = "Constraint", props = { "Attachment0", "Attachment1", "Enabled", "Visible" } },
	{ class = "JointInstance", props = { "C0", "C1", "Part0", "Part1" } },
	{ class = "WeldConstraint", props = { "Enabled", "Part0", "Part1" } },
	{ class = "Decal", props = { "Color3", "Face", "Texture", "Transparency" } },
	{ class = "Texture", props = { "Face", "StudsPerTileU", "StudsPerTileV", "Texture" } },
	{ class = "SurfaceAppearance", props = { "AlphaMode", "ColorMap", "MetalnessMap", "NormalMap", "RoughnessMap" } },
	{ class = "MaterialVariant", props = { "BaseMaterial", "MaterialPattern", "StudsPerTile" } },
	{ class = "MaterialVariant", props = SURFACE_MAP_PROPS },
	{
		class = "Sound",
		props = { "Looped", "PlaybackSpeed", "Playing", "RollOffMaxDistance", "SoundId", "TimePosition", "Volume" },
	},
	{
		class = "ParticleEmitter",
		props = {
			"Color",
			"Enabled",
			"LightEmission",
			"Lifetime",
			"Rate",
			"Size",
			"Speed",
			"SpreadAngle",
			"Texture",
			"Transparency",
		},
	},
	{ class = "Beam", props = { "Attachment0", "Attachment1", "Color", "Enabled", "Texture", "Width0", "Width1" } },
	{ class = "Trail", props = { "Attachment0", "Attachment1", "Color", "Enabled", "Lifetime", "Texture" } },
	{ class = "ValueBase", props = { "Value" } },
	{ class = "BaseScript", props = { "Enabled" } },
	{ class = "Script", props = { "RunContext" } },
	{ class = "Tool", props = { "CanBeDropped", "Enabled", "Grip", "RequiresHandle", "TextureId", "ToolTip" } },
	{ class = "GuiBase2d", props = { "AbsolutePosition", "AbsoluteSize", "AbsoluteRotation" } },
	{
		class = "GuiObject",
		props = {
			"AnchorPoint",
			"AutomaticSize",
			"BackgroundColor3",
			"BackgroundTransparency",
			"BorderColor3",
			"BorderSizePixel",
			"ClipsDescendants",
			"Interactable",
			"LayoutOrder",
			"Position",
			"Rotation",
			"Size",
			"SizeConstraint",
			"Visible",
			"ZIndex",
		},
	},
	{ class = "TextLabel", props = TEXT_PROPS },
	{ class = "TextButton", props = TEXT_PROPS },
	{ class = "TextBox", props = TEXT_PROPS },
	{ class = "ImageLabel", props = IMAGE_PROPS },
	{ class = "ImageButton", props = IMAGE_PROPS },
	{
		class = "ScrollingFrame",
		props = {
			"AutomaticCanvasSize",
			"CanvasPosition",
			"CanvasSize",
			"ElasticBehavior",
			"ScrollBarThickness",
			"ScrollingDirection",
			"VerticalScrollBarInset",
		},
	},
	{ class = "LayerCollector", props = { "Enabled", "ResetOnSpawn", "ZIndexBehavior" } },
	{ class = "SurfaceGui", props = { "Adornee", "AlwaysOnTop", "CanvasSize", "Face", "LightInfluence", "PixelsPerStud" } },
	{
		class = "BillboardGui",
		props = { "Adornee", "AlwaysOnTop", "ExtentsOffset", "LightInfluence", "MaxDistance", "Size", "SizeOffset", "StudsOffset" },
	},
	{
		class = "ScreenGui",
		props = { "ClipToDeviceSafeArea", "DisplayOrder", "IgnoreGuiInset", "SafeAreaCompatibility", "ScreenInsets" },
	},
	{
		class = "UIGridStyleLayout",
		props = { "FillDirection", "HorizontalAlignment", "SortOrder", "VerticalAlignment" },
	},
	{ class = "UIListLayout", props = { "HorizontalFlex", "ItemLineAlignment", "Padding", "VerticalFlex", "Wraps" } },
	{ class = "UIGridLayout", props = { "CellPadding", "CellSize", "FillDirectionMaxCells", "StartCorner" } },
	{ class = "UITableLayout", props = { "FillEmptySpaceColumns", "FillEmptySpaceRows", "MajorAxis", "Padding" } },
	{
		class = "UIPageLayout",
		props = { "Animated", "Circular", "EasingDirection", "EasingStyle", "Padding", "TweenTime" },
	},
	{ class = "UIPadding", props = { "PaddingBottom", "PaddingLeft", "PaddingRight", "PaddingTop" } },
	{ class = "UIAspectRatioConstraint", props = { "AspectRatio", "AspectType", "DominantAxis" } },
	{ class = "UISizeConstraint", props = { "MaxSize", "MinSize" } },
	{ class = "UITextSizeConstraint", props = { "MaxTextSize", "MinTextSize" } },
	{ class = "UICorner", props = { "CornerRadius" } },
	{ class = "UIStroke", props = { "ApplyStrokeMode", "Color", "Enabled", "LineJoinMode", "Thickness", "Transparency" } },
	{ class = "UIGradient", props = { "Color", "Enabled", "Offset", "Rotation", "Transparency" } },
	{ class = "UIScale", props = { "Scale" } },
	{ class = "UIFlexItem", props = { "FlexMode", "GrowRatio", "ItemLineAlignment", "ShrinkRatio" } },
	{ class = "Terrain", props = { "Decoration", "WaterColor", "WaterTransparency", "WaterWaveSize" } },
	{ class = "Workspace", props = { "Gravity", "StreamingEnabled" } },
	{
		class = "Lighting",
		props = {
			"Ambient",
			"Brightness",
			"ClockTime",
			"EnvironmentDiffuseScale",
			"EnvironmentSpecularScale",
			"GlobalShadows",
			"OutdoorAmbient",
			"ShadowSoftness",
			"Technology",
		},
	},
	{ class = "Players", props = { "CharacterAutoLoads", "MaxPlayers", "RespawnTime" } },
}

local REF_PROPS = {
	"Adornee",
	"Attachment0",
	"Attachment1",
	"CameraSubject",
	"Part0",
	"Part1",
	"PrimaryPart",
	"Value",
}

local defaultCache: { [string]: any } = {}

local function defaultInstance(className: string): Instance?
	local cached = defaultCache[className]
	if cached ~= nil then
		return if cached == false then nil else cached
	end
	local ok, inst = pcall(Instance.new, className)
	defaultCache[className] = if ok then inst else false
	return if ok then inst else nil
end

local function deepEqual(a: any, b: any): boolean
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" then
		return false
	end
	for key, value in pairs(a) do
		if not deepEqual(value, (b :: any)[key]) then
			return false
		end
	end
	for key in pairs(b) do
		if (a :: any)[key] == nil then
			return false
		end
	end
	return true
end

local function globToPattern(glob: string): string
	local out = "^"
	for i = 1, #glob do
		local ch = string.sub(glob, i, i)
		if ch == "*" then
			out ..= ".*"
		elseif ch == "?" then
			out ..= "."
		elseif string.find(ch, "^[%w_ ]$") then
			out ..= ch
		else
			out ..= "%" .. ch
		end
	end
	return out .. "$"
end

local function memberNames(inst: Instance): { string }
	local names = {}
	local seen: { [string]: boolean } = {}
	local function add(list: { string })
		for _, name in list do
			if not seen[name] then
				seen[name] = true
				table.insert(names, name)
			end
		end
	end
	add(BASE_PROPS)
	for _, entry in PROP_SETS do
		local ok, isa = pcall(function()
			return inst:IsA(entry.class)
		end)
		if ok and isa then
			add(entry.props)
		end
	end
	return names
end

local function readProps(inst: Instance, request: any): { [string]: any }
	local nonDefaultOnly = request == "*"
	local names: { string }
	if type(request) == "table" then
		names = {}
		for _, name in request do
			if type(name) == "string" then
				table.insert(names, name)
			end
		end
	else
		names = memberNames(inst)
	end

	local reference = if nonDefaultOnly then defaultInstance(inst.ClassName) else nil
	local props: { [string]: any } = {}
	for _, name in names do
		local ok, value = Serde.readProp(inst, name)
		if ok then
			if reference then
				local refOk, refValue = Serde.readProp(reference, name)
				if refOk and deepEqual(value, refValue) then
					continue
				end
			end
			props[name] = value
		end
	end
	return props
end

local function readAttributes(inst: Instance, request: any): { [string]: any }
	local out: { [string]: any } = {}
	if type(request) == "table" then
		for _, name in request do
			local ok, value = pcall(function()
				return inst:GetAttribute(name)
			end)
			if ok and value ~= nil then
				out[name] = Serde.encode(value)
			end
		end
		return out
	end
	local ok, attrs = pcall(function()
		return inst:GetAttributes()
	end)
	if ok then
		for name, value in pairs(attrs) do
			out[name] = Serde.encode(value)
		end
	end
	return out
end

local function outgoingRefs(inst: Instance): { any }
	local refs = {}
	for _, name in REF_PROPS do
		local ok, value = pcall(function()
			return (inst :: any)[name]
		end)
		if ok and typeof(value) == "Instance" then
			table.insert(refs, { prop = name, path = Path.of(value) })
		end
	end
	return refs
end

local function serviceAncestor(inst: Instance): Instance
	local current = inst
	while current.Parent and current.Parent ~= game do
		current = current.Parent
	end
	return current
end

local function incomingRefs(inst: Instance): ({ any }, boolean)
	local refs = {}
	local scanned = 0
	local truncated = false
	for _, candidate in serviceAncestor(inst):GetDescendants() do
		scanned += 1
		if scanned > INCOMING_SCAN_CAP then
			truncated = true
			break
		end
		if scanned % YIELD_EVERY == 0 then
			task.wait()
		end
		if candidate == inst then
			continue
		end
		for _, name in REF_PROPS do
			local ok, value = pcall(function()
				return (candidate :: any)[name]
			end)
			if ok and value == inst then
				table.insert(refs, { prop = name, path = Path.of(candidate) })
			end
		end
	end
	return refs, truncated
end

local function resolveEach(paths: any, errors: { any }): { Instance }
	local list: { any } = if type(paths) == "table" then paths else { paths }
	local out = {}
	for _, path in list do
		if type(path) ~= "string" then
			table.insert(errors, { path = tostring(path), err = "path must be a string" })
			continue
		end
		local found, err = Path.resolveMulti(path)
		if err then
			table.insert(errors, { path = path, err = err })
			continue
		end
		for _, inst in found do
			table.insert(out, inst)
		end
	end
	return out
end

local function decodeOffset(value: any): any
	if value == nil then
		return nil
	end
	if type(value) ~= "table" then
		error("offset must be [x,y,z] or a 12-number CFrame array")
	end
	local targetType = if #value == 12 then "CFrame" else "Vector3"
	local decoded, err = Serde.decode(value, targetType)
	if err then
		error("bad offset: " .. err)
	end
	return decoded
end

local function applyOffset(inst: Instance, offset: any, index: number)
	if offset == nil or index == 0 then
		return
	end
	local ok, err = pcall(function()
		if typeof(offset) == "Vector3" then
			local delta = offset * index
			if inst:IsA("BasePart") then
				inst.Position += delta
			elseif inst:IsA("Attachment") then
				inst.Position += delta
			elseif inst:IsA("Model") then
				inst:PivotTo(inst:GetPivot() + delta)
			end
		else
			local total = CFrame.new()
			for _ = 1, index do
				total = total * offset
			end
			if inst:IsA("BasePart") then
				inst.CFrame = inst.CFrame * total
			elseif inst:IsA("Model") then
				inst:PivotTo(inst:GetPivot() * total)
			end
		end
	end)
	if not ok then
		error("cannot apply offset to " .. inst.ClassName .. ": " .. tostring(err))
	end
end

local function applyProps(inst: Instance, props: any, errors: { any }): number
	if type(props) ~= "table" then
		return 0
	end
	local applied = 0
	for name, value in pairs(props) do
		local err = Serde.writeProp(inst, name, value)
		if err then
			table.insert(errors, { path = Path.of(inst), err = name .. ": " .. err })
		else
			applied += 1
		end
	end
	return applied
end

-- JSON null cannot survive HttpService:JSONDecode inside an object, so attribute
-- deletion arrives as an `attrs_remove` name list rather than `attrs.X = null`.
local function attributeValue(value: any): any
	if type(value) ~= "table" then
		return value
	end
	local targetType = if type(value.type) == "string" then value.type else nil
	local payload = if targetType then value.value else value
	if not targetType then
		local size = #value
		targetType = if size == 12 then "CFrame" elseif size == 3 then "Vector3" elseif size == 2 then "Vector2" else nil
	end
	if not targetType then
		error("attribute values must be primitives or {type=..., value=...}")
	end
	local decoded, err = Serde.decode(payload, targetType)
	if err then
		error(err)
	end
	return decoded
end

local function applyAttrs(inst: Instance, attrs: any, remove: any, errors: { any })
	if type(attrs) == "table" then
		for name, value in pairs(attrs) do
			local ok, err = pcall(function()
				inst:SetAttribute(name, attributeValue(value))
			end)
			if not ok then
				table.insert(errors, { path = Path.of(inst), err = "attr " .. name .. ": " .. tostring(err) })
			end
		end
	end
	if type(remove) == "table" then
		for _, name in remove do
			pcall(function()
				inst:SetAttribute(name, nil)
			end)
		end
	end
end

local function applyTags(inst: Instance, add: any, remove: any, errors: { any })
	if type(add) == "table" then
		for _, tag in add do
			local ok, err = pcall(function()
				CollectionService:AddTag(inst, tag)
			end)
			if not ok then
				table.insert(errors, { path = Path.of(inst), err = "tag " .. tostring(tag) .. ": " .. tostring(err) })
			end
		end
	end
	if type(remove) == "table" then
		for _, tag in remove do
			pcall(function()
				CollectionService:RemoveTag(inst, tag)
			end)
		end
	end
end

local function substituteName(template: string, index: number): string
	local out = string.gsub(template, "{n}", tostring(index))
	return out
end

local function createItems(items: any, defaultParent: Instance?, created: { string }, errors: { any })
	if type(items) ~= "table" then
		error("create requires an items array")
	end
	for _, item in items do
		if type(item) ~= "table" or type(item.class) ~= "string" then
			table.insert(errors, { err = "each item needs a class name" })
			continue
		end
		local parent = defaultParent
		if type(item.parent) == "string" then
			local resolved, err = Path.resolve(item.parent)
			if not resolved then
				table.insert(errors, { path = item.parent, err = err or "parent not found" })
				continue
			end
			parent = resolved
		end
		if not parent then
			table.insert(errors, { err = item.class .. ": no parent given" })
			continue
		end

		local count = math.max(tonumber(item.count) or 1, 1)
		local offsetOk, offset = pcall(decodeOffset, item.offset)
		if not offsetOk then
			table.insert(errors, { err = item.class .. ": " .. tostring(offset) })
			continue
		end

		for index = 0, count - 1 do
			local instOk, inst = pcall(Instance.new, item.class)
			if not instOk then
				table.insert(errors, { err = "cannot create " .. item.class .. ": " .. tostring(inst) })
				break
			end
			if type(item.name) == "string" then
				inst.Name = substituteName(item.name, index + 1)
			end
			applyProps(inst, item.props, errors)
			applyAttrs(inst, item.attrs, item.attrs_remove, errors)
			applyTags(inst, item.tags, nil, errors)
			inst.Parent = parent
			local offsetApplied, offsetErr = pcall(applyOffset, inst, offset, index)
			if not offsetApplied then
				table.insert(errors, { path = Path.of(inst), err = tostring(offsetErr) })
			end
			if item.children ~= nil then
				createItems(item.children, inst, created, errors)
			end
			table.insert(created, Path.of(inst))
		end
	end
end

local function matchesClass(inst: Instance, class: string, inherit: boolean): boolean
	if not inherit then
		return inst.ClassName == class
	end
	local ok, isa = pcall(function()
		return inst:IsA(class)
	end)
	return ok and isa
end

local function comparePropValue(actual: any, op: string, expected: any): boolean
	if op == "eq" then
		return deepEqual(actual, expected)
	elseif op == "ne" then
		return not deepEqual(actual, expected)
	elseif op == "lt" then
		return type(actual) == "number" and type(expected) == "number" and actual < expected
	elseif op == "gt" then
		return type(actual) == "number" and type(expected) == "number" and actual > expected
	elseif op == "contains" then
		if type(actual) == "string" then
			return string.find(actual, tostring(expected), 1, true) ~= nil
		end
		if type(actual) == "table" then
			for _, value in pairs(actual) do
				if deepEqual(value, expected) then
					return true
				end
			end
		end
		return false
	end
	error("unknown prop op '" .. tostring(op) .. "' (eq|ne|lt|gt|contains)")
end

local function lineCount(inst: Instance): number
	local ok, source = pcall(function()
		return (inst :: any).Source
	end)
	if not ok or type(source) ~= "string" then
		return 0
	end
	if source == "" then
		return 0
	end
	local _, newlines = string.gsub(source, "\n", "")
	return newlines + 1
end

local function makeFilter(filter: any): ((Instance) -> boolean)?
	if filter == nil then
		return nil
	end
	local list: { any } = if type(filter) == "table" then filter else { filter }
	local scriptsOnly = false
	local classes: { string } = {}
	for _, entry in list do
		if entry == "scripts" then
			scriptsOnly = true
		elseif type(entry) == "string" then
			table.insert(classes, entry)
		end
	end
	return function(inst: Instance): boolean
		if scriptsOnly and inst:IsA("LuaSourceContainer") then
			return true
		end
		for _, class in classes do
			if matchesClass(inst, class, true) then
				return true
			end
		end
		return false
	end
end

return function(register: Register)
	-- One call = one undo step; a dry run writes nothing, so it records nothing.
	local function registerWrite(name: string, label: string, handler: (any) -> any)
		register(name, function(args: any): any
			if type(args) == "table" and args.dryRun == true then
				return handler(args)
			end
			return Recording.run(label, function()
				return handler(args)
			end)
		end)
	end

	register("inst.get", function(args: any): any
		local errors = {}
		local targets = resolveEach(args.paths or args.path or "@selection", errors)
		local instances = {}
		for _, inst in targets do
			local entry: any = {
				path = Path.of(inst),
				class = inst.ClassName,
				props = readProps(inst, args.props),
			}
			if args.attrs ~= nil and args.attrs ~= false then
				entry.attrs = readAttributes(inst, args.attrs)
			end
			if args.tags == true then
				local ok, tags = pcall(function()
					return CollectionService:GetTags(inst)
				end)
				entry.tags = if ok then tags else {}
			end
			if args.refs == true then
				local incoming, truncated = incomingRefs(inst)
				entry.refs = { outgoing = outgoingRefs(inst), incoming = incoming, truncated = truncated }
			end
			if inst == game then
				entry.place = {
					placeId = game.PlaceId,
					gameId = game.GameId,
					name = game.Name,
				}
			end
			table.insert(instances, entry)
		end
		local list, truncated, total = Output.capList(instances)
		return { instances = list, truncated = truncated, total = total, errors = errors }
	end)

	registerWrite("inst.set", "OGSync set", function(args: any): any
		local targets = args.targets
		if type(targets) ~= "table" then
			error("set requires a targets array")
		end
		local errors = {}
		local instanceCount = 0
		local propCount = 0
		local hashes = {}
		for _, target in targets do
			if type(target) ~= "table" then
				table.insert(errors, { err = "each target must be an object" })
				continue
			end
			-- Source travels beside props (binary-safe, maybe staged) and is
			-- written through the editor-aware verified path, never as a raw prop.
			local takeOk, sourceText, sourceHash = pcall(Source.take, target, "source")
			if not takeOk then
				table.insert(errors, { path = tostring(target.path or "?"), err = tostring(sourceText) })
				continue
			end
			local resolved = resolveEach(target.paths or target.path, errors)
			for _, inst in resolved do
				instanceCount += 1
				if sourceText ~= nil then
					if not inst:IsA("LuaSourceContainer") then
						table.insert(errors, { path = Path.of(inst), err = "Source: " .. inst.ClassName .. " is not a script" })
					else
						local writeOk, written = pcall(Source.write, inst, sourceText, sourceHash)
						if writeOk then
							propCount += 1
							table.insert(hashes, { path = Path.of(inst), hash = written.hash, editor = written.editor })
						else
							table.insert(errors, { path = Path.of(inst), err = "Source: " .. tostring(written) })
						end
					end
				end
				propCount += applyProps(inst, target.props, errors)
				applyAttrs(inst, target.attrs, target.attrs_remove, errors)
				applyTags(inst, target.tags_add, target.tags_remove, errors)
				if type(target.name) == "string" then
					local ok, err = pcall(function()
						inst.Name = target.name
					end)
					if not ok then
						table.insert(errors, { path = Path.of(inst), err = "name: " .. tostring(err) })
					end
				end
				if type(target.parent) == "string" then
					local parent, err = Path.resolve(target.parent)
					if not parent then
						table.insert(errors, { path = Path.of(inst), err = err or "parent not found" })
					else
						local ok, moveErr = pcall(function()
							inst.Parent = parent
						end)
						if not ok then
							table.insert(errors, { path = Path.of(inst), err = "parent: " .. tostring(moveErr) })
						end
					end
				end
			end
		end
		return { instances = instanceCount, properties = propCount, errors = errors, sources = hashes }
	end)

	registerWrite("inst.create", "OGSync create", function(args: any): any
		local created: { string } = {}
		local errors = {}
		createItems(args.items, nil, created, errors)
		local list, truncated, total = Output.capList(created)
		return { created = list, truncated = truncated, total = total, errors = errors }
	end)

	registerWrite("inst.delete", "OGSync delete", function(args: any): any
		-- Destroy() locks Parent, so Undo could never bring the instance back;
		-- in edit mode a detach inside the recording is what Studio's own Delete does.
		local undoable = not RunService:IsRunning()
		local errors = {}
		local targets = resolveEach(args.paths or args.path, errors)
		local deleted = 0
		for _, inst in targets do
			if inst == game then
				table.insert(errors, { path = "@game", err = "refusing to delete the DataModel" })
				continue
			end
			if inst.Parent == game and Path.SERVICES[inst.Name] then
				table.insert(errors, { path = Path.of(inst), err = "refusing to delete service " .. inst.Name })
				continue
			end
			local path = Path.of(inst)
			local ok, err = pcall(function()
				if undoable then
					inst.Parent = nil
				else
					inst:Destroy()
				end
			end)
			if ok then
				deleted += 1
			else
				table.insert(errors, { path = path, err = tostring(err) })
			end
		end
		return { deleted = deleted, errors = errors }
	end)

	registerWrite("inst.duplicate", "OGSync duplicate", function(args: any): any
		local source, resolveErr = Path.resolve(args.path)
		if not source then
			error(resolveErr or "path not found")
		end
		local parent: Instance? = source.Parent
		if type(args.parent) == "string" then
			local resolved, err = Path.resolve(args.parent)
			if not resolved then
				error(err or "parent not found")
			end
			parent = resolved
		end
		if not parent then
			error("duplicate needs a parent (source has none)")
		end

		local count = math.max(tonumber(args.count) or 1, 1)
		local offset = decodeOffset(args.offset)
		local perCopy = if type(args.props_per_copy) == "table" then args.props_per_copy else nil
		local created: { string } = {}
		local errors = {}
		for index = 0, count - 1 do
			local cloneOk, clone = pcall(function()
				return source:Clone()
			end)
			if not cloneOk or not clone then
				error("cannot clone " .. Path.of(source) .. " (Archivable false?): " .. tostring(clone))
			end
			if type(args.name) == "string" then
				clone.Name = substituteName(args.name, index + 1)
			end
			clone.Parent = parent
			applyOffset(clone, offset, index)
			if perCopy and perCopy[index + 1] then
				applyProps(clone, perCopy[index + 1], errors)
			end
			table.insert(created, Path.of(clone))
		end
		local list, truncated, total = Output.capList(created)
		return { created = list, truncated = truncated, total = total, errors = errors }
	end)

	registerWrite("inst.transform", "OGSync transform", function(args: any): any
		local targets = args.targets
		if type(targets) ~= "table" then
			error("transform requires a targets array")
		end
		local errors = {}
		local groups = {}
		for _, target in targets do
			if type(target) ~= "table" then
				table.insert(errors, { err = "each target must be an object" })
				continue
			end
			local specOk, spec = pcall(Transform.decodeSpec, target)
			if not specOk then
				table.insert(errors, { path = tostring(target.path or "?"), err = tostring(spec) })
				continue
			end
			local members = {}
			for _, inst in resolveEach(target.paths or target.path, errors) do
				if inst:IsA("PVInstance") then
					table.insert(members, { inst = inst, from = (inst :: PVInstance):GetPivot() })
				else
					table.insert(errors, { path = Path.of(inst), err = inst.ClassName .. " has no pivot (Model or BasePart only)" })
				end
			end
			table.insert(groups, { spec = spec, members = members })
		end

		local steps, skipped = Transform.plan(groups)
		local planned = {}
		for _, step in steps do
			local from = Transform.describe(step.from)
			local to = Transform.describe(step.to)
			table.insert(planned, { path = Path.of(step.inst), from = from[1], to = to[1], rotFrom = from[2], rotTo = to[2] })
		end
		local skips = {}
		for _, skip in skipped do
			table.insert(skips, { path = Path.of(skip.inst), ancestor = Path.of(skip.ancestor) })
		end
		local list, truncated, total = Output.capList(planned)
		if args.dryRun == true then
			return { dryRun = true, planned = list, truncated = truncated, total = total, skipped = skips, errors = errors }
		end

		local moved = 0
		for _, step in steps do
			local ok, err = pcall(function()
				(step.inst :: PVInstance):PivotTo(step.to)
			end)
			if ok then
				moved += 1
			else
				table.insert(errors, { path = Path.of(step.inst), err = "PivotTo: " .. tostring(err) })
			end
		end
		-- Every pivot was precomputed, so a member dragged by a welded partner
		-- after its own PivotTo shows up here as drift rather than silently.
		for _, step in steps do
			local drift = ((step.inst :: PVInstance):GetPivot().Position - step.to.Position).Magnitude
			if drift > 1e-3 then
				table.insert(errors, { path = Path.of(step.inst), err = string.format("ended %.3f studs off target (welded to a moved part?)", drift) })
			end
		end
		return { moved = moved, planned = list, truncated = truncated, total = total, skipped = skips, errors = errors }
	end)

	register("inst.find", function(args: any): any
		local root, err = Path.resolve(args.root or "@game")
		if not root then
			error(err or "root not found")
		end
		local limit = math.max(tonumber(args.limit) or FIND_LIMIT_DEFAULT, 1)
		local inherit = args.inherit ~= false
		local namePattern = if type(args.name) == "string" then globToPattern(args.name) else nil
		local prop = if type(args.prop) == "table" then args.prop else nil
		if prop and type(prop.name) ~= "string" then
			error("prop query needs a name")
		end

		local candidates: { Instance }
		if type(args.tag) == "string" then
			candidates = {}
			for _, inst in CollectionService:GetTagged(args.tag) do
				if inst == root or root:IsAncestorOf(inst) then
					table.insert(candidates, inst)
				end
			end
		else
			candidates = root:GetDescendants()
		end

		local matches = {}
		local scanned = 0
		local truncated = false
		for _, inst in candidates do
			scanned += 1
			if scanned % YIELD_EVERY == 0 then
				task.wait()
			end
			if type(args.class) == "string" and not matchesClass(inst, args.class, inherit) then
				continue
			end
			if namePattern and not string.find(inst.Name, namePattern) then
				continue
			end
			if prop then
				local ok, value = Serde.readProp(inst, prop.name)
				if not ok or not comparePropValue(value, prop.op or "eq", prop.value) then
					continue
				end
			end
			table.insert(matches, { path = Path.of(inst), class = inst.ClassName })
			if #matches >= limit then
				truncated = scanned < #candidates
				break
			end
		end
		local list, capped, total = Output.capList(matches)
		return { matches = list, truncated = truncated or capped, total = total, scanned = scanned }
	end)

	register("inst.tree", function(args: any): any
		local root, err = Path.resolve(args.path or "@game")
		if not root then
			error(err or "path not found")
		end
		local depth = math.max(tonumber(args.depth) or 2, 0)
		local counts = args.counts == true
		local filter = makeFilter(args.filter)
		local nodes = 0
		local truncated = false

		local function build(inst: Instance, remaining: number): (any, boolean)
			nodes += 1
			if nodes % YIELD_EVERY == 0 then
				task.wait()
			end
			local children = inst:GetChildren()
			local node: any = { n = inst.Name, c = inst.ClassName, k = #children }
			if inst:IsA("LuaSourceContainer") then
				node.ln = lineCount(inst)
			end
			local included = filter == nil or filter(inst)
			if remaining > 0 and not counts then
				local kids = {}
				for _, child in children do
					if nodes >= TREE_NODE_CAP then
						truncated = true
						break
					end
					local childNode, childIncluded = build(child, remaining - 1)
					if childIncluded then
						table.insert(kids, childNode)
						included = true
					end
				end
				if #kids > 0 then
					node.ch = kids
				end
			end
			return node, included
		end

		local node = build(root, depth)
		return { root = node, truncated = truncated, nodes = nodes }
	end)
end
