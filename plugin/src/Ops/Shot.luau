--!strict
-- shot.capture: CaptureService → EditableImage → base64 RGBA; the daemon turns the pixels into a PNG.
-- Camera and UI changes made for a capture are always undone, even when it fails.

local AssetService = game:GetService("AssetService")
local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local Workspace = game:GetService("Workspace")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)

type Register = (string, (any) -> any) -> ()

local CAPTURE_TIMEOUT_S = 4
local CAPTURE_TIMEOUT_MAX_S = 30
local SETTLE_SECONDS = 0.1
local FULLSCREEN_SHARE = 0.95
local OPAQUE_BELOW = 0.05
local GUI_SCAN_CAP = 5000
local WORLD_SCAN_CAP = 200000
local YIELD_EVERY = 5000
-- Output sizes past this are clamped (and say so): 1920x1080 is ~11 MB of
-- base64, already ~15 chunked round trips.
local MAX_OUTPUT_PIXELS = 1920 * 1080
-- Base64 chars per result, a multiple of 4, under the 1 MB result cap.
local PIXEL_CHUNK_CHARS = 768 * 1024

-- Only the latest capture's remaining chunks are kept.
local storedPixels: { id: string, data: string, chunks: number }? = nil
local pixelsSerial = 0
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

local function localPlayerGui(): PlayerGui?
	local player = Players.LocalPlayer
	if player == nil or not RunService:IsRunning() then
		return nil
	end
	return player:FindFirstChildOfClass("PlayerGui")
end

-- The ScreenGuis this viewport draws: the local PlayerGui in a play client,
-- StarterGui's development preview in edit.
local function visibleScreenGuis(): { ScreenGui }
	local out = {}
	local playerGui = localPlayerGui()
	local root: Instance? = playerGui
	if root == nil and not RunService:IsRunning() and StarterGui.ShowDevelopmentGui then
		root = StarterGui
	end
	if root == nil then
		return out
	end
	for _, child in (root :: Instance):GetChildren() do
		if child:IsA("ScreenGui") and child.Enabled then
			table.insert(out, child)
		end
	end
	return out
end

-- Returns the restore function; callers run it in their cleanup path.
local function frameCamera(pathValue: string): () -> ()
	local target, err = Path.resolve(pathValue)
	if not target then
		error(err or ("no instance at " .. pathValue))
	end
	local camera = Workspace.CurrentCamera
	if not camera then
		error("screenshot unsupported: no CurrentCamera to frame " .. pathValue)
	end
	local center: Vector3
	local extents: Vector3
	if target:IsA("Model") then
		local box, size = target:GetBoundingBox()
		center, extents = box.Position, size
	elseif target:IsA("BasePart") then
		center, extents = target.Position, target.Size
	elseif target:IsA("Attachment") then
		center, extents = target.WorldPosition, Vector3.one
	else
		error("frame needs a Model, BasePart or Attachment, got " .. target.ClassName)
	end

	local saved = {
		cameraType = camera.CameraType,
		cframe = camera.CFrame,
		focus = camera.Focus,
		fieldOfView = camera.FieldOfView,
	}
	local radius = math.max(extents.Magnitude / 2, 2)
	local distance = radius / math.sin(math.rad(camera.FieldOfView) / 2) * 1.1
	local ok, cameraErr = pcall(function()
		if RunService:IsRunning() then
			-- Camera scripts rewrite CFrame every frame unless the camera is scripted.
			camera.CameraType = Enum.CameraType.Scriptable
		end
		camera.CFrame = CFrame.lookAt(center + Vector3.new(1, 0.8, 1).Unit * distance, center)
		camera.Focus = CFrame.new(center)
	end)
	local function restore()
		camera.CFrame = saved.cframe
		camera.Focus = saved.focus
		camera.FieldOfView = saved.fieldOfView
		camera.CameraType = saved.cameraType
	end
	if not ok then
		pcall(restore)
		error("screenshot unsupported: cannot move camera (" .. tostring(cameraErr) .. ")")
	end
	return restore
end

local function hideUi(): () -> ()
	local playerGui = localPlayerGui()
	if playerGui ~= nil then
		local hidden = {}
		for _, gui in visibleScreenGuis() do
			gui.Enabled = false
			table.insert(hidden, gui)
		end
		return function()
			for _, gui in hidden do
				if gui.Parent ~= nil then
					gui.Enabled = true
				end
			end
		end
	end
	-- Edit viewport: Studio's own UI-visibility toggle, so no ScreenGui is
	-- touched. It is still a saved StarterGui property that can replicate in
	-- Team Create, so the restore below is load-bearing.
	local previous = StarterGui.ShowDevelopmentGui
	local ok, err = pcall(function()
		StarterGui.ShowDevelopmentGui = false
	end)
	if not ok then
		error("hide_ui unsupported here: cannot toggle StarterGui.ShowDevelopmentGui (" .. tostring(err) .. ")")
	end
	return function()
		StarterGui.ShowDevelopmentGui = previous
	end
end

local function guiVisible(object: GuiObject, root: Instance): boolean
	local current: Instance? = object
	while current ~= nil and current ~= root do
		if current:IsA("GuiObject") and not current.Visible then
			return false
		end
		current = current.Parent
	end
	return true
end

local function opaque(object: GuiObject): boolean
	if object.BackgroundTransparency < OPAQUE_BELOW then
		return true
	end
	if object:IsA("ImageLabel") or object:IsA("ImageButton") then
		return object.Image ~= "" and object.ImageTransparency < OPAQUE_BELOW
	end
	return object:IsA("ViewportFrame") or object:IsA("VideoFrame")
end

-- A forgotten loading screen or draft frame left Enabled turns the capture into
-- a flat colour; name the culprit instead of returning a mystery image.
local function fullscreenOpaque(viewport: Vector2): { string }
	local culprits = {}
	for _, gui in visibleScreenGuis() do
		local scanned = 0
		for _, descendant in gui:GetDescendants() do
			scanned += 1
			if scanned > GUI_SCAN_CAP then
				break
			end
			if not descendant:IsA("GuiObject") then
				continue
			end
			local size = descendant.AbsoluteSize
			if size.X >= viewport.X * FULLSCREEN_SHARE and size.Y >= viewport.Y * FULLSCREEN_SHARE and opaque(descendant) and guiVisible(descendant, gui) then
				table.insert(culprits, Path.of(descendant))
				break
			end
		end
	end
	return culprits
end

local function alwaysOnTopCount(): number
	local count = 0
	local scanned = 0
	local roots: { Instance } = { Workspace }
	local playerGui = localPlayerGui()
	if playerGui ~= nil then
		table.insert(roots, playerGui)
	end
	for _, root in roots do
		for _, descendant in root:GetDescendants() do
			scanned += 1
			if scanned > WORLD_SCAN_CAP then
				return count
			end
			if scanned % YIELD_EVERY == 0 then
				task.wait()
			end
			local class = descendant.ClassName
			if (class == "BillboardGui" or class == "SurfaceGui") and (descendant :: any).AlwaysOnTop and (descendant :: any).Enabled then
				count += 1
			end
		end
	end
	return count
end

local function captureContentId(timeout: number): string
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
	local deadline = os.clock() + timeout
	while contentId == nil and os.clock() < deadline do
		task.wait(0.05)
	end
	if contentId == nil then
		error(
			string.format(
				"capture timed out after %.1fs: this viewport is not painting (Studio minimized, covered, on another desktop, or the session locked); during a playtest capture context=client",
				timeout
			)
		)
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
	local lastErr: any = nil
	for _, attempt in attempts do
		local ok, image = pcall(attempt)
		if ok and image then
			return image
		end
		lastErr = image
	end
	error("screenshot unsupported: AssetService:CreateEditableImageAsync (" .. tostring(lastErr) .. ")")
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

local function readImage(args: any, image: any): any
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
	-- Fit inside the requested box keeping the aspect ratio; never upscale.
	local wantWidth, wantHeight = parseSize(args.size)
	local fit = 1
	if wantWidth and wantHeight then
		fit = math.min(wantWidth / width, wantHeight / height, 1)
	end
	local clamped = false
	if width * height * fit * fit > MAX_OUTPUT_PIXELS then
		fit = math.sqrt(MAX_OUTPUT_PIXELS / (width * height))
		clamped = true
	end

	local outWidth = math.max(math.floor(width * fit + 0.5), 1)
	local outHeight = math.max(math.floor(height * fit + 0.5), 1)
	local stepX = width / outWidth
	local stepY = height / outHeight
	local bytes = buffer.create(outWidth * outHeight * 4)
	local offset = 0
	for y = 0, outHeight - 1 do
		local sourceY = math.min(math.floor((y + 0.5) * stepY), height - 1)
		for x = 0, outWidth - 1 do
			local r, g, b, a = readPixel(math.min(math.floor((x + 0.5) * stepX), width - 1), sourceY)
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

	-- Pixels larger than one result (1 MB wire cap) are fetched in chunks:
	-- the first rides here, the rest come from shot.read {pixels, chunk}.
	local encoded = base64(bytes)
	local chunks = math.max(math.ceil(#encoded / PIXEL_CHUNK_CHARS), 1)
	pixelsSerial += 1
	local id = tostring(pixelsSerial)
	storedPixels = if chunks > 1 then { id = id, data = encoded, chunks = chunks } else nil
	return {
		w = outWidth,
		h = outHeight,
		rgba = string.sub(encoded, 1, PIXEL_CHUNK_CHARS),
		chunks = chunks,
		pixels = id,
		source = { w = width, h = height },
		clamped = if clamped then MAX_OUTPUT_PIXELS else nil,
	}
end

-- EditableImages hold engine memory until destroyed, so every path frees it.
local function readContent(args: any, contentId: string): any
	local image = editableImage(contentId)
	local ok, result = pcall(readImage, args, image)
	pcall(function()
		image:Destroy()
	end)
	if not ok then
		error(result, 0)
	end
	return result
end

-- A play DataModel may capture but not promote the temporary texture to an
-- EditableImage ("cannot create editable image from temporary texture id"),
-- so play captures stop at the content id and the edit DataModel, which may,
-- reads the pixels through shot.read.
local function capture(args: any, timeout: number): any
	local contentId = captureContentId(timeout)
	if args.content_only == true then
		return { contentId = contentId }
	end
	return readContent(args, contentId)
end

return function(register: Register)
	register("shot.capture", function(args: any): any
		local target = args.target or "viewport"
		if target ~= "viewport" then
			error("screenshot unsupported: target '" .. tostring(target) .. "' (only viewport)")
		end
		local timeout = math.clamp((tonumber(args.capture_timeout_ms) or CAPTURE_TIMEOUT_S * 1000) / 1000, 0.5, CAPTURE_TIMEOUT_MAX_S)
		local camera = Workspace.CurrentCamera
		local viewport = if camera then camera.ViewportSize else Vector2.zero
		local frame = args.frame or args.camera_focus

		local warnings = {}
		local restorers: { () -> () } = {}
		local ok, result = pcall(function(): any
			if args.hide_ui == true then
				table.insert(restorers, hideUi())
			elseif viewport.X > 0 then
				for _, culprit in fullscreenOpaque(viewport) do
					table.insert(warnings, "fullscreen opaque GUI covers the 3D view: " .. culprit)
				end
			end
			if type(frame) == "string" then
				table.insert(restorers, frameCamera(frame))
			end
			if #restorers > 0 then
				task.wait(SETTLE_SECONDS)
			end
			local onTop = alwaysOnTopCount()
			if onTop > 0 then
				table.insert(
					warnings,
					string.format("%d AlwaysOnTop BillboardGui/SurfaceGui present; CaptureService captures can omit them", onTop)
				)
			end
			return capture(args, timeout)
		end)
		for index = #restorers, 1, -1 do
			pcall(restorers[index])
		end
		if not ok then
			error(result, 0)
		end

		local inset = GuiService:GetGuiInset()
		result.viewport = { w = viewport.X, h = viewport.Y }
		result.inset = { x = inset.X, y = inset.Y }
		-- Output pixels per viewport (input) pixel: divide an image coordinate by
		-- this to get the x/y an `input` click expects.
		result.scale = if viewport.X > 0 and result.w ~= nil then result.w / viewport.X else nil
		result.warnings = warnings
		return result
	end)

	register("shot.read", function(args: any): any
		if args.pixels ~= nil then
			local stored = storedPixels
			local chunk = tonumber(args.chunk)
			if stored == nil or stored.id ~= tostring(args.pixels) then
				error("capture " .. tostring(args.pixels) .. " is gone (a newer capture replaced it); take the screenshot again")
			end
			if chunk == nil or chunk < 1 or chunk > stored.chunks then
				error(string.format("chunk must be 1..%d", stored.chunks))
			end
			if chunk == stored.chunks then
				storedPixels = nil
			end
			local first = (chunk - 1) * PIXEL_CHUNK_CHARS + 1
			return { rgba = string.sub(stored.data, first, first + PIXEL_CHUNK_CHARS - 1) }
		end
		if type(args.contentId) ~= "string" then
			error("shot.read needs the contentId a play-context shot.capture returned")
		end
		return readContent(args, args.contentId)
	end)
end
