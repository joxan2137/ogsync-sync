--!strict
-- shot.capture: CaptureService → EditableImage → base64 RGBA; the daemon turns the pixels into a PNG.

local AssetService = game:GetService("AssetService")
local Workspace = game:GetService("Workspace")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)

type Register = (string, (any) -> any) -> ()

local CAPTURE_TIMEOUT_S = 10
local MAX_RAW_BYTES = 512 * 1024
local B64_GROUPS_PER_CHUNK = 4096

local B64_CHARS: { string } = {}
do
	local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for index = 1, #alphabet do
		B64_CHARS[index - 1] = string.sub(alphabet, index, index)
	end
end

local function base64(bytes: buffer): string
	local length = buffer.len(bytes)
	local pieces = {}
	local chunk = {}
	local groups = 0
	local index = 0
	while index < length do
		local b1 = buffer.readu8(bytes, index)
		local b2 = if index + 1 < length then buffer.readu8(bytes, index + 1) else 0
		local b3 = if index + 2 < length then buffer.readu8(bytes, index + 2) else 0
		local packed = b1 * 65536 + b2 * 256 + b3
		local remaining = length - index
		local group = B64_CHARS[bit32.rshift(packed, 18)]
			.. B64_CHARS[bit32.band(bit32.rshift(packed, 12), 63)]
			.. (if remaining > 1 then B64_CHARS[bit32.band(bit32.rshift(packed, 6), 63)] else "=")
			.. (if remaining > 2 then B64_CHARS[bit32.band(packed, 63)] else "=")
		table.insert(chunk, group)
		groups += 1
		if groups >= B64_GROUPS_PER_CHUNK then
			table.insert(pieces, table.concat(chunk))
			chunk = {}
			groups = 0
		end
		index += 3
	end
	if #chunk > 0 then
		table.insert(pieces, table.concat(chunk))
	end
	return table.concat(pieces)
end

local function focusCamera(pathValue: string)
	local target, err = Path.resolve(pathValue)
	if not target then
		error(err or ("no instance at " .. pathValue))
	end
	local camera = Workspace.CurrentCamera
	if not camera then
		error("screenshot unsupported: no CurrentCamera to frame camera_focus")
	end
	local pivot: CFrame
	local extents: Vector3
	if target:IsA("Model") then
		pivot = target:GetPivot()
		extents = target:GetExtentsSize()
	elseif target:IsA("BasePart") then
		pivot = target.CFrame
		extents = target.Size
	else
		error("camera_focus needs a Model or BasePart, got " .. target.ClassName)
	end
	local distance = math.max(extents.Magnitude, 4) * 1.5
	local ok, cameraErr = pcall(function()
		camera.CFrame = CFrame.lookAt(pivot.Position + Vector3.new(1, 0.8, 1).Unit * distance, pivot.Position)
	end)
	if not ok then
		error("screenshot unsupported: cannot move camera (" .. tostring(cameraErr) .. ")")
	end
	task.wait(0.1)
end

local function captureContentId(): string
	local serviceOk, captureService = pcall(function()
		return game:GetService("CaptureService")
	end)
	if not serviceOk or not captureService then
		error("screenshot unsupported: CaptureService")
	end
	local contentId: string? = nil
	local startOk, startErr = pcall(function()
		(captureService :: any):CaptureScreenshot(function(id: string)
			contentId = id
		end)
	end)
	if not startOk then
		error("screenshot unsupported: CaptureService:CaptureScreenshot (" .. tostring(startErr) .. ")")
	end
	local deadline = os.clock() + CAPTURE_TIMEOUT_S
	while contentId == nil and os.clock() < deadline do
		task.wait(0.05)
	end
	if contentId == nil then
		error("screenshot unsupported: capture callback never fired")
	end
	return contentId :: string
end

local function editableImage(contentId: string): any
	local attempts = {
		function()
			return AssetService:CreateEditableImageAsync((Content :: any).fromUri(contentId))
		end,
		function()
			return (AssetService :: any):CreateEditableImageAsync(contentId)
		end,
	}
	for _, attempt in attempts do
		local ok, image = pcall(attempt)
		if ok and image then
			return image
		end
	end
	error("screenshot unsupported: AssetService:CreateEditableImageAsync")
end

local function pixelReader(image: any, width: number, height: number): (number, number) -> (number, number, number, number)
	local size = Vector2.new(width, height)
	local bufferOk, pixels = pcall(function()
		return image:ReadPixelsBuffer(Vector2.zero, size)
	end)
	if bufferOk and pixels then
		return function(x: number, y: number)
			local base = (y * width + x) * 4
			return buffer.readu8(pixels, base),
				buffer.readu8(pixels, base + 1),
				buffer.readu8(pixels, base + 2),
				buffer.readu8(pixels, base + 3)
		end
	end
	local arrayOk, values = pcall(function()
		return image:ReadPixels(Vector2.zero, size)
	end)
	if arrayOk and type(values) == "table" then
		local scale = 255
		for index = 1, math.min(#values, 64) do
			if values[index] > 1.001 then
				scale = 1
				break
			end
		end
		local function byteAt(offset: number): number
			return math.clamp(math.floor((values[offset] or 0) * scale + 0.5), 0, 255)
		end
		return function(x: number, y: number)
			local base = (y * width + x) * 4
			return byteAt(base + 1), byteAt(base + 2), byteAt(base + 3), byteAt(base + 4)
		end
	end
	error("screenshot unsupported: EditableImage:ReadPixelsBuffer/ReadPixels")
end

local function parseSize(size: any): (number?, number?)
	if type(size) ~= "string" then
		return nil, nil
	end
	local w, h = string.match(size, "^(%d+)[xX](%d+)$")
	if not w or not h then
		error("size must look like 960x540")
	end
	return tonumber(w), tonumber(h)
end

return function(register: Register)
	register("shot.capture", function(args: any): any
		local target = args.target or "viewport"
		if target ~= "viewport" then
			error("screenshot unsupported: target '" .. tostring(target) .. "' (only viewport)")
		end
		if type(args.camera_focus) == "string" then
			focusCamera(args.camera_focus)
		end

		local contentId = captureContentId()
		local image = editableImage(contentId)
		local sizeOk, imageSize = pcall(function()
			return image.Size
		end)
		if not sizeOk or not imageSize then
			error("screenshot unsupported: EditableImage.Size")
		end
		local width = math.floor(imageSize.X)
		local height = math.floor(imageSize.Y)
		if width <= 0 or height <= 0 then
			error("screenshot unsupported: capture returned an empty image")
		end

		local readPixel = pixelReader(image, width, height)
		local wantWidth, wantHeight = parseSize(args.size)
		local stride = 1
		if wantWidth and wantHeight then
			stride = math.max(math.ceil(math.max(width / wantWidth, height / wantHeight)), 1)
		end
		-- Keep the base64 payload under the 1 MB wire cap by dropping rows/columns.
		while math.ceil(width / stride) * math.ceil(height / stride) * 4 > MAX_RAW_BYTES do
			stride += 1
		end

		local outWidth = math.ceil(width / stride)
		local outHeight = math.ceil(height / stride)
		local bytes = buffer.create(outWidth * outHeight * 4)
		local offset = 0
		for y = 0, outHeight - 1 do
			local sourceY = math.min(y * stride, height - 1)
			for x = 0, outWidth - 1 do
				local r, g, b, a = readPixel(math.min(x * stride, width - 1), sourceY)
				buffer.writeu8(bytes, offset, r)
				buffer.writeu8(bytes, offset + 1, g)
				buffer.writeu8(bytes, offset + 2, b)
				buffer.writeu8(bytes, offset + 3, a)
				offset += 4
			end
			if y % 64 == 0 then
				task.wait()
			end
		end

		pcall(function()
			image:Destroy()
		end)

		return {
			w = outWidth,
			h = outHeight,
			rgba = base64(bytes),
			source = { w = width, h = height },
			stride = stride,
		}
	end)
end
