--!strict
-- Rojo-style property JSON (docs/TOOLS.md): Vector3 [x,y,z], Color3 [r,g,b]
-- 0-1 floats, CFrame [12 components], UDim2 [[sx,ox],[sy,oy]], enums
-- "Enum.Material.Neon", instance refs as dot-paths.

local Path = require(script.Parent.Path)

local Serde = {}

local DEFAULT_DEPTH = 8

local function encodeNumber(value: number): any
	if value ~= value then
		return "nan"
	end
	if value == math.huge then
		return "inf"
	end
	if value == -math.huge then
		return "-inf"
	end
	return value
end

local function isArray(t: {[any]: any}): boolean
	local count = 0
	for _ in t do
		count += 1
	end
	return count == #t
end

local encodeValue: (value: any, depth: number, seen: {[any]: boolean}) -> any

local function encodeList(values: {any}, depth: number, seen: {[any]: boolean}): {any}
	local out: {any} = {}
	for index, value in values do
		out[index] = encodeValue(value, depth, seen)
	end
	return out
end

function encodeValue(value: any, depth: number, seen: {[any]: boolean}): any
	local kind = typeof(value)
	if value == nil then
		return nil
	elseif kind == "boolean" or kind == "string" then
		return value
	elseif kind == "number" then
		return encodeNumber(value :: number)
	elseif kind == "Vector3" then
		local v = value :: Vector3
		return { v.X, v.Y, v.Z }
	elseif kind == "Vector2" then
		local v = value :: Vector2
		return { v.X, v.Y }
	elseif kind == "Vector3int16" then
		local v = value :: Vector3int16
		return { v.X, v.Y, v.Z }
	elseif kind == "Vector2int16" then
		local v = value :: Vector2int16
		return { v.X, v.Y }
	elseif kind == "Color3" then
		local c = value :: Color3
		return { c.R, c.G, c.B }
	elseif kind == "BrickColor" then
		return (value :: BrickColor).Name
	elseif kind == "CFrame" then
		return { (value :: CFrame):GetComponents() }
	elseif kind == "UDim" then
		local u = value :: UDim
		return { u.Scale, u.Offset }
	elseif kind == "UDim2" then
		local u = value :: UDim2
		return { { u.X.Scale, u.X.Offset }, { u.Y.Scale, u.Y.Offset } }
	elseif kind == "Rect" then
		local r = value :: Rect
		return { { r.Min.X, r.Min.Y }, { r.Max.X, r.Max.Y } }
	elseif kind == "NumberRange" then
		local r = value :: NumberRange
		return { r.Min, r.Max }
	elseif kind == "NumberSequence" then
		local out: {any} = {}
		for index, keypoint in (value :: NumberSequence).Keypoints do
			out[index] = { time = keypoint.Time, value = keypoint.Value, envelope = keypoint.Envelope }
		end
		return out
	elseif kind == "ColorSequence" then
		local out: {any} = {}
		for index, keypoint in (value :: ColorSequence).Keypoints do
			local c = keypoint.Value
			out[index] = { time = keypoint.Time, color = { c.R, c.G, c.B } }
		end
		return out
	elseif kind == "NumberSequenceKeypoint" then
		local k = value :: NumberSequenceKeypoint
		return { time = k.Time, value = k.Value, envelope = k.Envelope }
	elseif kind == "ColorSequenceKeypoint" then
		local k = value :: ColorSequenceKeypoint
		return { time = k.Time, color = { k.Value.R, k.Value.G, k.Value.B } }
	elseif kind == "EnumItem" then
		return tostring(value)
	elseif kind == "Enum" or kind == "Enums" then
		return tostring(value)
	elseif kind == "Instance" then
		return Path.of(value :: Instance)
	elseif kind == "Faces" then
		local faces = value :: Faces
		local out: {string} = {}
		for _, name in { "Top", "Bottom", "Left", "Right", "Front", "Back" } do
			if (faces :: any)[name] then
				table.insert(out, name)
			end
		end
		return out
	elseif kind == "Axes" then
		local axes = value :: Axes
		local out: {string} = {}
		for _, name in { "X", "Y", "Z" } do
			if (axes :: any)[name] then
				table.insert(out, name)
			end
		end
		return out
	elseif kind == "PhysicalProperties" then
		local p = value :: PhysicalProperties
		return {
			density = p.Density,
			friction = p.Friction,
			elasticity = p.Elasticity,
			frictionWeight = p.FrictionWeight,
			elasticityWeight = p.ElasticityWeight,
		}
	elseif kind == "Font" then
		local f = value :: Font
		return { family = f.Family, weight = tostring(f.Weight), style = tostring(f.Style) }
	elseif kind == "Ray" then
		local r = value :: Ray
		return {
			origin = { r.Origin.X, r.Origin.Y, r.Origin.Z },
			direction = { r.Direction.X, r.Direction.Y, r.Direction.Z },
		}
	elseif kind == "Region3" then
		local r = value :: Region3
		return {
			cframe = { r.CFrame:GetComponents() },
			size = { r.Size.X, r.Size.Y, r.Size.Z },
		}
	elseif kind == "table" then
		if depth <= 0 then
			return "<depth>"
		end
		local t = value :: {[any]: any}
		if seen[t] then
			return "<cycle>"
		end
		seen[t] = true
		local out: any
		if isArray(t) then
			out = encodeList(t :: {any}, depth - 1, seen)
		else
			local map: {[string]: any} = {}
			for key, item in t do
				map[tostring(key)] = encodeValue(item, depth - 1, seen)
			end
			out = map
		end
		seen[t] = nil
		return out
	end
	return tostring(value)
end

function Serde.encode(value: any, maxDepth: number?): any
	return encodeValue(value, maxDepth or DEFAULT_DEPTH, {})
end

-- ------------------------------------------------------------------ decode

local function numbersOf(value: any, count: number): ({number}?, string?)
	if type(value) ~= "table" then
		return nil, string.format("expected array of %d numbers", count)
	end
	local list = value :: {any}
	local out: {number} = {}
	for index = 1, count do
		local n = list[index]
		if type(n) ~= "number" then
			return nil, string.format("expected array of %d numbers", count)
		end
		out[index] = n
	end
	return out, nil
end

local function axis(value: any, index: number, keys: {string}): number?
	if type(value) ~= "table" then
		return nil
	end
	local t = value :: {[any]: any}
	local direct = t[index]
	if type(direct) == "number" then
		return direct
	end
	for _, key in keys do
		local named = t[key]
		if type(named) == "number" then
			return named
		end
	end
	return nil
end

local decoders: {[string]: (value: any) -> (any, string?)} = {}

decoders.Vector3 = function(value)
	local x, y, z = axis(value, 1, { "x", "X" }), axis(value, 2, { "y", "Y" }), axis(value, 3, { "z", "Z" })
	if not (x and y and z) then
		return nil, "expected Vector3 as [x,y,z]"
	end
	return Vector3.new(x, y, z), nil
end

decoders.Vector2 = function(value)
	local x, y = axis(value, 1, { "x", "X" }), axis(value, 2, { "y", "Y" })
	if not (x and y) then
		return nil, "expected Vector2 as [x,y]"
	end
	return Vector2.new(x, y), nil
end

decoders.Color3 = function(value)
	if type(value) == "string" then
		local ok, color = pcall(function(): Color3
			return BrickColor.new(value :: string).Color
		end)
		if ok then
			return color, nil
		end
		return nil, "unknown color name " .. value
	end
	local rgb, err = numbersOf(value, 3)
	if not rgb then
		return nil, err or "expected Color3 as [r,g,b]"
	end
	local scale = if rgb[1] > 1 or rgb[2] > 1 or rgb[3] > 1 then 255 else 1
	return Color3.new(rgb[1] / scale, rgb[2] / scale, rgb[3] / scale), nil
end

decoders.BrickColor = function(value)
	if type(value) ~= "string" then
		return nil, "expected BrickColor name"
	end
	local ok, color = pcall(function(): BrickColor
		return BrickColor.new(value :: string)
	end)
	if not ok then
		return nil, "unknown BrickColor " .. value
	end
	return color, nil
end

decoders.CFrame = function(value)
	local components, err = numbersOf(value, 12)
	if not components then
		return nil, err or "expected CFrame as 12 numbers"
	end
	return CFrame.new(
		components[1], components[2], components[3],
		components[4], components[5], components[6],
		components[7], components[8], components[9],
		components[10], components[11], components[12]
	), nil
end

decoders.UDim = function(value)
	local scale, offset = axis(value, 1, { "scale", "Scale" }), axis(value, 2, { "offset", "Offset" })
	if not (scale and offset) then
		return nil, "expected UDim as [scale,offset]"
	end
	return UDim.new(scale, offset), nil
end

decoders.UDim2 = function(value)
	if type(value) ~= "table" then
		return nil, "expected UDim2 as [[sx,ox],[sy,oy]]"
	end
	local t = value :: {any}
	if type(t[1]) == "table" and type(t[2]) == "table" then
		local x, xErr = numbersOf(t[1], 2)
		local y, yErr = numbersOf(t[2], 2)
		if not (x and y) then
			return nil, xErr or yErr or "expected UDim2 as [[sx,ox],[sy,oy]]"
		end
		return UDim2.new(x[1], x[2], y[1], y[2]), nil
	end
	local flat, err = numbersOf(value, 4)
	if not flat then
		return nil, err or "expected UDim2 as [[sx,ox],[sy,oy]]"
	end
	return UDim2.new(flat[1], flat[2], flat[3], flat[4]), nil
end

decoders.Rect = function(value)
	if type(value) ~= "table" then
		return nil, "expected Rect as [[minx,miny],[maxx,maxy]]"
	end
	local t = value :: {any}
	local min, minErr = numbersOf(t[1], 2)
	local max, maxErr = numbersOf(t[2], 2)
	if not (min and max) then
		return nil, minErr or maxErr or "expected Rect as [[minx,miny],[maxx,maxy]]"
	end
	return Rect.new(min[1], min[2], max[1], max[2]), nil
end

decoders.NumberRange = function(value)
	if type(value) == "number" then
		return NumberRange.new(value), nil
	end
	local range, err = numbersOf(value, 2)
	if not range then
		return nil, err or "expected NumberRange as [min,max]"
	end
	return NumberRange.new(range[1], range[2]), nil
end

decoders.NumberSequence = function(value)
	if type(value) == "number" then
		return NumberSequence.new(value), nil
	end
	if type(value) ~= "table" then
		return nil, "expected NumberSequence keypoint array"
	end
	local keypoints: {NumberSequenceKeypoint} = {}
	for index, entry in value :: {any} do
		local time = axis(entry, 1, { "time", "Time" })
		local amount = axis(entry, 2, { "value", "Value" })
		local envelope = axis(entry, 3, { "envelope", "Envelope" }) or 0
		if not (time and amount) then
			return nil, string.format("bad NumberSequence keypoint at %d", index)
		end
		keypoints[index] = NumberSequenceKeypoint.new(time, amount, envelope)
	end
	if #keypoints < 2 then
		return nil, "NumberSequence needs at least 2 keypoints"
	end
	return NumberSequence.new(keypoints), nil
end

decoders.ColorSequence = function(value)
	if type(value) ~= "table" then
		return nil, "expected ColorSequence keypoint array"
	end
	local keypoints: {ColorSequenceKeypoint} = {}
	for index, entry in value :: {any} do
		local time = axis(entry, 1, { "time", "Time" })
		local colorValue = if type(entry) == "table" then (entry :: {[any]: any}).color or (entry :: {[any]: any})[2] else nil
		if time == nil or colorValue == nil then
			return nil, string.format("bad ColorSequence keypoint at %d", index)
		end
		local color, colorErr = decoders.Color3(colorValue)
		if colorErr then
			return nil, colorErr
		end
		keypoints[index] = ColorSequenceKeypoint.new(time, color)
	end
	if #keypoints < 2 then
		return nil, "ColorSequence needs at least 2 keypoints"
	end
	return ColorSequence.new(keypoints), nil
end

decoders.PhysicalProperties = function(value)
	if type(value) ~= "table" then
		return nil, "expected PhysicalProperties table"
	end
	local t = value :: {[string]: any}
	local density = t.density or t.Density
	if type(density) ~= "number" then
		return nil, "PhysicalProperties needs density"
	end
	return PhysicalProperties.new(
		density,
		t.friction or t.Friction or 0.3,
		t.elasticity or t.Elasticity or 0.5,
		t.frictionWeight or t.FrictionWeight or 1,
		t.elasticityWeight or t.ElasticityWeight or 1
	), nil
end

decoders.Instance = function(value)
	if value == nil then
		return nil, nil
	end
	if typeof(value) == "Instance" then
		return value, nil
	end
	if type(value) ~= "string" then
		return nil, "expected instance dot-path"
	end
	local inst, err = Path.resolve(value :: string)
	if not inst then
		return nil, err or "unresolved instance path"
	end
	return inst, nil
end

decoders.string = function(value)
	if type(value) == "string" then
		return value, nil
	end
	return tostring(value), nil
end

decoders.number = function(value)
	if type(value) == "number" then
		return value, nil
	end
	local parsed = tonumber(value)
	if parsed == nil then
		return nil, "expected number"
	end
	return parsed, nil
end

decoders.boolean = function(value)
	if type(value) == "boolean" then
		return value, nil
	end
	if value == "true" or value == 1 then
		return true, nil
	end
	if value == "false" or value == 0 then
		return false, nil
	end
	return nil, "expected boolean"
end

decoders.Font = function(value)
	if type(value) == "string" then
		local ok, font = pcall(function(): Font
			return Font.new(value :: string)
		end)
		if not ok then
			return nil, "unknown font " .. (value :: string)
		end
		return font, nil
	end
	if type(value) ~= "table" then
		return nil, "expected Font table"
	end
	local t = value :: {[string]: any}
	local family = t.family or t.Family
	if type(family) ~= "string" then
		return nil, "Font needs family"
	end
	local weight = Enum.FontWeight.Regular
	local weightName = t.weight or t.Weight
	if type(weightName) == "string" then
		local named = (Enum.FontWeight :: any)[string.match(weightName, "[%w]+$") or weightName]
		if named then
			weight = named
		end
	end
	return Font.new(family, weight), nil
end

local function decodeEnum(value: any, enumType: Enum): (any, string?)
	if typeof(value) == "EnumItem" then
		return value, nil
	end
	if type(value) == "number" then
		for _, item in enumType:GetEnumItems() do
			if item.Value == value then
				return item, nil
			end
		end
		return nil, string.format("no %s with value %d", tostring(enumType), value)
	end
	if type(value) ~= "string" then
		return nil, "expected enum name"
	end
	local shortName = string.match(value :: string, "[%w_]+$") or value
	local item = (enumType :: any)[shortName]
	if item == nil then
		return nil, string.format("unknown %s.%s", tostring(enumType), shortName)
	end
	return item, nil
end

function Serde.decode(value: any, targetType: string): (any, string?)
	local decoder = decoders[targetType]
	if decoder then
		return decoder(value)
	end
	if targetType == "bool" then
		return decoders.boolean(value)
	end
	if targetType == "int" or targetType == "int64" or targetType == "float" or targetType == "double" then
		return decoders.number(value)
	end
	if targetType == "EnumItem" then
		if typeof(value) == "EnumItem" then
			return value, nil
		end
		return nil, "enum target type unknown"
	end
	local enumName = string.match(targetType, "^Enum%.(.+)$") or targetType
	local enumType = (Enum :: any)[enumName]
	if enumType ~= nil then
		return decodeEnum(value, enumType)
	end
	if type(value) == "table" or type(value) == "string" or type(value) == "number" or type(value) == "boolean" then
		return value, nil
	end
	return nil, string.format("cannot decode %s", targetType)
end

-- ------------------------------------------------------------------ properties

function Serde.readProp(inst: Instance, name: string): (boolean, any)
	local okRead, raw = pcall(function(): any
		return (inst :: any)[name]
	end)
	if not okRead then
		return false, string.format("cannot read %s.%s", inst.ClassName, name)
	end
	local okEncode, encoded = pcall(Serde.encode, raw)
	if not okEncode then
		return false, string.format("cannot serialize %s.%s", inst.ClassName, name)
	end
	return true, encoded
end

function Serde.writeProp(inst: Instance, name: string, jsonValue: any): string?
	local okRead, current = pcall(function(): any
		return (inst :: any)[name]
	end)
	if not okRead then
		return string.format("%s has no property %s", inst.ClassName, name)
	end
	local targetType: string
	local currentType = typeof(current)
	if currentType == "EnumItem" then
		targetType = tostring((current :: EnumItem).EnumType)
	elseif current == nil then
		targetType = if type(jsonValue) == "string" then "Instance" else typeof(jsonValue)
	else
		targetType = currentType
	end

	local decoded: any = nil
	if jsonValue ~= nil then
		local value, err = Serde.decode(jsonValue, targetType)
		if err then
			return err
		end
		decoded = value
	end

	local okWrite, writeErr = pcall(function()
		(inst :: any)[name] = decoded
	end)
	if not okWrite then
		return tostring(writeErr)
	end
	return nil
end

return Serde
