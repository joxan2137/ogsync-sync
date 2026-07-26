--!strict
-- Connection panel (docs/PLUGIN_CONTRACT.md §Connection panel). Edit role only.
-- Net/Applier/Dispatcher push state through setState; every render is deferred so
-- the transport never waits on UI work. Dependencies are injected via start() so
-- this module stays a leaf (Dispatcher requires it for sync.conflicts).

local Theme = require(script.Parent.Theme)

local WIDGET_ID = "OGSyncPanel"
local DEFAULT_PORT = 3667
local FLOAT_WIDTH = 320
local FLOAT_HEIGHT = 260
local PADDING = 8
local GAP = 4
local ROW_HEIGHT = 22
local FIXED_HEIGHT = 148
local MIN_CONFLICT_HEIGHT = 60

local Panel = {}

export type Conflict = { file: string, path: string?, ts: number? }

export type State = {
	status: string,
	reason: string?,
	serverVersion: string?,
	projectName: string?,
	updatePlugin: boolean,
	retryIn: number?,
	syncEnabled: boolean,
	paused: boolean,
	pending: number,
	conflicts: {Conflict},
	connected: boolean,
	port: number,
	version: string,
}

export type Config = {
	plugin: Plugin,
	version: string,
	port: number,
	connected: boolean,
	pushEvent: (ev: any) -> (),
	setConnected: (enabled: boolean) -> (),
	setPort: (port: number) -> (),
	onVisibility: ((visible: boolean) -> ())?,
}

local STATUS_TEXT: {[string]: string} = {
	connected = "Connected",
	connecting = "Connecting…",
	disconnected = "Disconnected",
	rejected = "Rejected",
	update = "Update required",
}

local state: State = {
	status = "disconnected",
	reason = nil,
	serverVersion = nil,
	projectName = nil,
	updatePlugin = false,
	retryIn = nil,
	syncEnabled = false,
	paused = false,
	pending = 0,
	conflicts = {},
	connected = false,
	port = DEFAULT_PORT,
	version = "0.0.0",
}

local config: Config? = nil
local widget: DockWidgetPluginGui? = nil
local refs: {[string]: any} = {}
local palette = Theme.palette()
local connections: {RBXScriptConnection} = {}
local disconnectTheme: (() -> ())? = nil
local built = false
local dirty: {[string]: boolean} = {}
local flushScheduled = false
local retryAt: number? = nil
local countingDown = false

-- ------------------------------------------------------------------ state

local function optionalString(value: any): string?
	return if type(value) == "string" and value ~= "" then value else nil
end

local COERCE: {[string]: (value: any) -> any} = {
	status = function(value: any): any
		return if type(value) == "string" and STATUS_TEXT[value] ~= nil then value else "disconnected"
	end,
	reason = optionalString,
	serverVersion = optionalString,
	projectName = optionalString,
	updatePlugin = function(value: any): any
		return value == true
	end,
	retryIn = function(value: any): any
		return if type(value) == "number" and value > 0 then value else nil
	end,
	syncEnabled = function(value: any): any
		return value == true
	end,
	paused = function(value: any): any
		return value == true
	end,
	pending = function(value: any): any
		return if type(value) == "number" and value > 0 then math.floor(value) else 0
	end,
	connected = function(value: any): any
		return value == true
	end,
	port = function(value: any): any
		local parsed = tonumber(value)
		if parsed ~= nil and parsed > 0 and parsed < 65536 then
			return math.floor(parsed)
		end
		return DEFAULT_PORT
	end,
	version = function(value: any): any
		return if type(value) == "string" and value ~= "" then value else state.version
	end,
	conflicts = function(value: any): any
		local out: {Conflict} = {}
		if type(value) ~= "table" then
			return out
		end
		for _, entry in value :: {any} do
			if type(entry) == "table" and type((entry :: any).file) == "string" then
				local item = entry :: any
				table.insert(out, {
					file = item.file,
					path = optionalString(item.path),
					ts = if type(item.ts) == "number" then item.ts else nil,
				})
			end
		end
		return out
	end,
}

local SECTIONS: {[string]: {string}} = {
	status = { "status" },
	reason = { "status" },
	serverVersion = { "status" },
	projectName = { "status" },
	retryIn = { "status" },
	updatePlugin = { "status", "footer" },
	connected = { "status", "connect", "sync" },
	port = { "connect" },
	syncEnabled = { "sync" },
	paused = { "sync" },
	pending = { "sync" },
	conflicts = { "conflicts" },
	version = { "footer" },
}

local renderers: {[string]: () -> ()} = {}

local function flush()
	flushScheduled = false
	local sections = dirty
	dirty = {}
	if not built then
		return
	end
	for section in sections do
		local render = renderers[section]
		if render ~= nil then
			render()
		end
	end
end

local function markDirty(section: string)
	dirty[section] = true
	if flushScheduled then
		return
	end
	flushScheduled = true
	task.defer(flush)
end

function Panel.setState(partial: any)
	if type(partial) ~= "table" then
		return
	end
	for key, value in partial :: {[string]: any} do
		local coerce = COERCE[key]
		if coerce == nil then
			continue
		end
		local coerced = coerce(value)
		if coerced ~= (state :: any)[key] then
			(state :: any)[key] = coerced
			for _, section in SECTIONS[key] do
				markDirty(section)
			end
		end
	end
	if (partial :: any).retryIn ~= nil then
		retryAt = if state.retryIn ~= nil then os.clock() + state.retryIn else nil
	elseif state.status ~= "connecting" then
		retryAt = nil
	end
end

function Panel.state(): State
	local snapshot = table.clone(state)
	snapshot.conflicts = table.clone(state.conflicts)
	return snapshot
end

-- ------------------------------------------------------------------ rendering

local function isOpen(): boolean
	local gui = widget
	return gui ~= nil and gui.Enabled
end

local function effectiveStatus(): string
	if state.updatePlugin and state.status == "connected" then
		return "update"
	end
	return state.status
end

local function statusColor(status: string): Color3
	if status == "connected" then
		return palette.ok
	elseif status == "connecting" then
		return palette.warn
	elseif status == "rejected" or status == "update" then
		return palette.bad
	end
	return palette.idle
end

local function detailText(status: string): string
	if status == "connected" then
		local parts: {string} = {}
		if state.serverVersion ~= nil then
			table.insert(parts, "daemon " .. state.serverVersion)
		end
		if state.projectName ~= nil then
			table.insert(parts, state.projectName)
		end
		return if #parts > 0 then table.concat(parts, " · ") else "bound to this place"
	elseif status == "connecting" then
		return state.reason or string.format("waiting for daemon on 127.0.0.1:%d", state.port)
	elseif status == "rejected" then
		return state.reason or "daemon refused this session"
	elseif status == "update" then
		return state.reason or "plugin and daemon protocol versions differ"
	end
	return "sync stopped — press Connect"
end

local ensureCountdown: () -> ()

renderers.status = function()
	local status = effectiveStatus()
	local text = STATUS_TEXT[status] or STATUS_TEXT.disconnected
	if status == "connecting" and retryAt ~= nil then
		local remaining = math.max(0, math.ceil(retryAt - os.clock()))
		text = string.format("%s (retry in %ds)", text, remaining)
	end
	refs.dot.BackgroundColor3 = statusColor(status)
	refs.statusText.Text = text
	refs.statusText.TextColor3 = palette.text
	refs.detail.Text = detailText(status)
	refs.detail.TextColor3 = palette.subText
	ensureCountdown()
end

renderers.connect = function()
	refs.connectButton.Text = if state.connected then "Disconnect" else "Connect"
	refs.connectButton.BackgroundColor3 = palette.button
	refs.connectButton.TextColor3 = palette.buttonText
	refs.portLabel.TextColor3 = palette.subText
	refs.portBox.BackgroundColor3 = palette.inputBackground
	refs.portBox.TextColor3 = palette.text
	if not refs.portBox:IsFocused() then
		refs.portBox.Text = tostring(state.port)
	end
end

local function syncText(): string
	if not state.connected then
		return "Sync: off"
	elseif not state.syncEnabled then
		return "Sync: off (daemon)"
	elseif state.paused then
		return "Sync: paused"
	elseif state.pending > 0 then
		return string.format("Sync: on (%d pending)", state.pending)
	end
	return "Sync: on"
end

renderers.sync = function()
	refs.syncText.Text = syncText()
	refs.syncText.TextColor3 = palette.text
	refs.pauseButton.Text = if state.paused then "Resume" else "Pause"
	refs.pauseButton.BackgroundColor3 = palette.button
	refs.pauseButton.TextColor3 = palette.buttonText
end

local function shortenPath(conflict: Conflict): string
	local label = conflict.path or conflict.file
	label = string.gsub(label, "^game%.", "")
	if #label > 30 then
		label = "…" .. string.sub(label, #label - 28)
	end
	return label
end

local function newButton(parent: Instance, name: string, text: string): TextButton
	local button = Instance.new("TextButton")
	button.Name = name
	button.AutoButtonColor = true
	button.BorderSizePixel = 0
	button.Font = Enum.Font.SourceSansSemibold
	button.TextSize = 13
	button.Text = text
	button.BackgroundColor3 = palette.button
	button.TextColor3 = palette.buttonText
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 4)
	corner.Parent = button
	button.Parent = parent
	return button
end

local function newLabel(parent: Instance, name: string, size: number): TextLabel
	local label = Instance.new("TextLabel")
	label.Name = name
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.SourceSans
	label.TextSize = size
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextTruncate = Enum.TextTruncate.AtEnd
	label.Text = ""
	label.TextColor3 = palette.text
	label.Parent = parent
	return label
end

local function conflictRow(conflict: Conflict, order: number): Frame
	local row = Instance.new("Frame")
	row.Name = "Conflict"
	row.Size = UDim2.new(1, 0, 0, ROW_HEIGHT)
	row.BackgroundColor3 = palette.panel
	row.BorderSizePixel = 0
	row.LayoutOrder = order

	local label = newLabel(row, "Path", 12)
	label.Size = UDim2.new(1, -146, 1, 0)
	label.Position = UDim2.fromOffset(4, 0)
	label.Text = shortenPath(conflict)
	label.TextColor3 = palette.text

	local keepStudio = newButton(row, "KeepStudio", "Keep Studio")
	keepStudio.AnchorPoint = Vector2.new(1, 0)
	keepStudio.Position = UDim2.new(1, -2, 0, 2)
	keepStudio.Size = UDim2.new(0, 74, 1, -4)

	local keepFs = newButton(row, "KeepFs", "Keep FS")
	keepFs.AnchorPoint = Vector2.new(1, 0)
	keepFs.Position = UDim2.new(1, -80, 0, 2)
	keepFs.Size = UDim2.new(0, 54, 1, -4)

	local function resolve(keep: string)
		local current = config
		if current ~= nil then
			current.pushEvent({ ev = "resolveConflict", file = conflict.file, keep = keep })
		end
		local remaining: {Conflict} = {}
		for _, entry in state.conflicts do
			if entry.file ~= conflict.file then
				table.insert(remaining, entry)
			end
		end
		state.conflicts = remaining
		markDirty("conflicts")
	end

	keepFs.MouseButton1Click:Connect(function()
		resolve("fs")
	end)
	keepStudio.MouseButton1Click:Connect(function()
		resolve("studio")
	end)
	return row
end

renderers.conflicts = function()
	local list = refs.conflictsList
	refs.conflictsHeader.Text = string.format("Conflicts (%d)", #state.conflicts)
	refs.conflictsHeader.TextColor3 = palette.subText
	list.BackgroundColor3 = palette.background
	list.ScrollBarImageColor3 = palette.border
	for _, child in list:GetChildren() do
		if child:IsA("GuiObject") then
			child:Destroy()
		end
	end
	if #state.conflicts == 0 then
		local empty = newLabel(list, "Empty", 12)
		empty.Size = UDim2.new(1, -8, 0, ROW_HEIGHT)
		empty.Position = UDim2.fromOffset(4, 0)
		empty.Text = "No conflicts"
		empty.TextColor3 = palette.subText
		list.CanvasSize = UDim2.new()
		return
	end
	for index, conflict in state.conflicts do
		conflictRow(conflict, index).Parent = list
	end
	list.CanvasSize = UDim2.fromOffset(0, #state.conflicts * (ROW_HEIGHT + 2))
end

renderers.footer = function()
	local text = "OGSync v" .. state.version
	if state.updatePlugin then
		text ..= " — daemon has a newer plugin, reload plugins"
	end
	refs.footer.Text = text
	refs.footer.TextColor3 = if state.updatePlugin then palette.warn else palette.subText
end

-- One-shot tick; renderers.status re-arms it, so the countdown stops by itself as
-- soon as the panel closes or the status changes.
function ensureCountdown()
	if countingDown or not built or not isOpen() or state.status ~= "connecting" or retryAt == nil then
		return
	end
	countingDown = true
	task.delay(1, function()
		countingDown = false
		if built and isOpen() and state.status == "connecting" and retryAt ~= nil then
			renderers.status()
		end
	end)
end

local function renderAll()
	for section in renderers do
		markDirty(section)
	end
end

-- ------------------------------------------------------------------ build

local function resizeConflicts()
	local gui = widget
	if gui == nil or not built then
		return
	end
	local available = gui.AbsoluteSize.Y - PADDING * 2 - FIXED_HEIGHT
	refs.conflictsList.Size = UDim2.new(1, 0, 0, math.max(MIN_CONFLICT_HEIGHT, available))
end

local function build(current: Config)
	local info = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Float,
		false,
		false,
		FLOAT_WIDTH,
		FLOAT_HEIGHT,
		260,
		200
	)
	local gui = current.plugin:CreateDockWidgetPluginGui(WIDGET_ID, info)
	gui.Name = "OGSyncPanel"
	gui.Title = "OGSync"
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	widget = gui

	local root = Instance.new("Frame")
	root.Name = "Root"
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = palette.background
	root.BorderSizePixel = 0
	root.ClipsDescendants = true
	root.Parent = gui
	refs.root = root

	local padding = Instance.new("UIPadding")
	padding.PaddingTop = UDim.new(0, PADDING)
	padding.PaddingBottom = UDim.new(0, PADDING)
	padding.PaddingLeft = UDim.new(0, PADDING)
	padding.PaddingRight = UDim.new(0, PADDING)
	padding.Parent = root

	local layout = Instance.new("UIListLayout")
	layout.FillDirection = Enum.FillDirection.Vertical
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, GAP)
	layout.Parent = root

	local function section(name: string, height: number, order: number): Frame
		local frame = Instance.new("Frame")
		frame.Name = name
		frame.BackgroundTransparency = 1
		frame.BorderSizePixel = 0
		frame.Size = UDim2.new(1, 0, 0, height)
		frame.LayoutOrder = order
		frame.Parent = root
		return frame
	end

	local header = section("Header", ROW_HEIGHT, 1)
	local dot = Instance.new("Frame")
	dot.Name = "Dot"
	dot.Size = UDim2.fromOffset(10, 10)
	dot.Position = UDim2.fromOffset(0, 6)
	dot.BorderSizePixel = 0
	dot.BackgroundColor3 = palette.idle
	local dotCorner = Instance.new("UICorner")
	dotCorner.CornerRadius = UDim.new(1, 0)
	dotCorner.Parent = dot
	dot.Parent = header
	refs.dot = dot

	local statusText = newLabel(header, "Status", 15)
	statusText.Size = UDim2.new(1, -18, 1, 0)
	statusText.Position = UDim2.fromOffset(18, 0)
	refs.statusText = statusText

	local detailRow = section("Detail", 16, 2)
	local detail = newLabel(detailRow, "Text", 12)
	detail.Size = UDim2.fromScale(1, 1)
	refs.detail = detail

	local connectRow = section("Connect", 26, 3)
	local connectButton = newButton(connectRow, "Toggle", "Connect")
	connectButton.Size = UDim2.new(0, 96, 1, 0)
	refs.connectButton = connectButton

	local portLabel = newLabel(connectRow, "PortLabel", 13)
	portLabel.Size = UDim2.new(0, 30, 1, 0)
	portLabel.Position = UDim2.fromOffset(104, 0)
	portLabel.Text = "Port"
	refs.portLabel = portLabel

	local portBox = Instance.new("TextBox")
	portBox.Name = "Port"
	portBox.Size = UDim2.new(0, 64, 1, 0)
	portBox.Position = UDim2.fromOffset(136, 0)
	portBox.BorderSizePixel = 0
	portBox.Font = Enum.Font.SourceSans
	portBox.TextSize = 13
	portBox.ClearTextOnFocus = false
	portBox.Text = tostring(state.port)
	portBox.BackgroundColor3 = palette.inputBackground
	portBox.TextColor3 = palette.text
	local portCorner = Instance.new("UICorner")
	portCorner.CornerRadius = UDim.new(0, 4)
	portCorner.Parent = portBox
	portBox.Parent = connectRow
	refs.portBox = portBox

	local syncRow = section("Sync", 26, 4)
	local syncLabel = newLabel(syncRow, "Text", 14)
	syncLabel.Size = UDim2.new(1, -98, 1, 0)
	refs.syncText = syncLabel

	local pauseButton = newButton(syncRow, "Pause", "Pause")
	pauseButton.AnchorPoint = Vector2.new(1, 0)
	pauseButton.Position = UDim2.fromScale(1, 0)
	pauseButton.Size = UDim2.new(0, 92, 1, 0)
	refs.pauseButton = pauseButton

	local conflictsHeaderRow = section("ConflictsHeader", 18, 5)
	local conflictsHeader = newLabel(conflictsHeaderRow, "Text", 13)
	conflictsHeader.Size = UDim2.fromScale(1, 1)
	refs.conflictsHeader = conflictsHeader

	local conflictsList = Instance.new("ScrollingFrame")
	conflictsList.Name = "Conflicts"
	conflictsList.Size = UDim2.new(1, 0, 0, MIN_CONFLICT_HEIGHT)
	conflictsList.LayoutOrder = 6
	conflictsList.BorderSizePixel = 0
	conflictsList.BackgroundColor3 = palette.background
	conflictsList.ScrollBarThickness = 6
	conflictsList.CanvasSize = UDim2.new()
	conflictsList.Parent = root
	local conflictsLayout = Instance.new("UIListLayout")
	conflictsLayout.SortOrder = Enum.SortOrder.LayoutOrder
	conflictsLayout.Padding = UDim.new(0, 2)
	conflictsLayout.Parent = conflictsList
	refs.conflictsList = conflictsList

	local footerRow = section("Footer", 16, 7)
	local footer = newLabel(footerRow, "Text", 12)
	footer.Size = UDim2.fromScale(1, 1)
	refs.footer = footer

	built = true

	table.insert(connections, connectButton.MouseButton1Click:Connect(function()
		current.setConnected(not state.connected)
	end))

	table.insert(connections, pauseButton.MouseButton1Click:Connect(function()
		local paused = not state.paused
		state.paused = paused
		markDirty("sync")
		current.pushEvent({ ev = "syncToggle", paused = paused })
	end))

	table.insert(connections, portBox.FocusLost:Connect(function(enterPressed: boolean)
		local parsed = tonumber(portBox.Text)
		if enterPressed and parsed ~= nil and parsed > 0 and parsed < 65536 and math.floor(parsed) ~= state.port then
			current.setPort(math.floor(parsed))
		else
			portBox.Text = tostring(state.port)
		end
	end))

	table.insert(connections, gui:GetPropertyChangedSignal("Enabled"):Connect(function()
		local visible = gui.Enabled
		local notify = current.onVisibility
		if notify ~= nil then
			notify(visible)
		end
		if visible then
			renderAll()
		end
	end))

	table.insert(connections, gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
		task.defer(resizeConflicts)
	end))

	disconnectTheme = Theme.onChanged(function()
		task.defer(function()
			palette = Theme.palette()
			if refs.root ~= nil then
				refs.root.BackgroundColor3 = palette.background
			end
			renderAll()
		end)
	end)

	resizeConflicts()
	renderAll()
end

-- ------------------------------------------------------------------ lifecycle

function Panel.start(startConfig: Config)
	if config ~= nil then
		return
	end
	config = startConfig
	Panel.setState({
		version = startConfig.version,
		port = startConfig.port,
		connected = startConfig.connected,
		status = if startConfig.connected then "connecting" else "disconnected",
	})
	build(startConfig)
	local notify = startConfig.onVisibility
	local gui = widget
	if notify ~= nil and gui ~= nil then
		notify(gui.Enabled)
	end
end

function Panel.toggle()
	local gui = widget
	if gui ~= nil then
		gui.Enabled = not gui.Enabled
	end
end

function Panel.isOpen(): boolean
	return isOpen()
end

function Panel.stop()
	countingDown = false
	for _, connection in connections do
		connection:Disconnect()
	end
	connections = {}
	local disconnect = disconnectTheme
	if disconnect ~= nil then
		disconnect()
	end
	disconnectTheme = nil
	local gui = widget
	if gui ~= nil then
		gui:Destroy()
	end
	widget = nil
	refs = {}
	built = false
	config = nil
end

return Panel
