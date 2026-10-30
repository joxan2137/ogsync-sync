--!strict
-- Entry point: one plugin instance per DataModel. Edit sessions own sync and the
-- toolbar, play-server sessions own the broker and the cross-DataModel stop
-- monitor, play-client sessions only answer broker invocations.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local Applier = require(script.Sync.Applier)
local Broker = require(script.Broker)
local Dispatcher = require(script.Dispatcher)
local Lifecycle = require(script.Lifecycle)
local Net = require(script.Net)
local Panel = require(script.UI.Panel)
local Version = require(script.Version)
local Watcher = require(script.Sync.Watcher)

local DEFAULT_PORT = 3667
local STOP_POLL_SECONDS = 0.5

local SETTING_PORT = "ogsync_port"
local SETTING_ENABLED = "ogsync_enabled"
local SETTING_STOP_TOKEN = Dispatcher.STOP_SETTING

-- Run mode (F8) simulates inside the edit DataModel, so a plugin (re)loaded
-- during it is still the edit session. IsRunMode is never true in a play-test
-- DataModel; it is false under a plugin's RunService:Run() too, which leaves
-- that rare reload case reading as server rather than risk a play server
-- registering as a second edit peer.
local function isRunMode(): boolean
	local ok, runMode = pcall(function(): boolean
		return RunService:IsRunMode()
	end)
	return ok and runMode == true
end

local function detectRole(): string
	if not RunService:IsRunning() or isRunMode() then
		return "edit"
	end
	return if RunService:IsServer() then "server" else "client"
end

local function readPort(): number
	local stored = plugin:GetSetting(SETTING_PORT)
	if type(stored) == "number" and stored > 0 and stored < 65536 then
		return stored
	end
	return DEFAULT_PORT
end

local function readEnabled(): boolean
	local stored = plugin:GetSetting(SETTING_ENABLED)
	return if type(stored) == "boolean" then stored else true
end

local role = detectRole()
local session = HttpService:GenerateGUID(false)
local port = readPort()
-- A play DataModel launched by OGSync carries the edit plugin's launch token
-- in its test args; presenting it pairs this session with the right place.
local function testLaunchToken(): string?
	if role == "edit" then
		return nil
	end
	local ok, testArgs = pcall(function(): any
		return (game:GetService("StudioTestService" :: any) :: any):GetTestArgs()
	end)
	if ok and type(testArgs) == "table" and type((testArgs :: any).ogsyncLaunch) == "string" then
		return (testArgs :: any).ogsyncLaunch
	end
	return nil
end

local config = {
	port = port,
	session = session,
	role = role,
	launch = testLaunchToken(),
}

Dispatcher.setup({ plugin = plugin, role = role, session = session })

local cleanups: {() -> ()} = {}

-- Edit and play-server sessions report playtest state; clients have no HTTP.
local function startLifecycle()
	Net.setConnectedHook(Lifecycle.connected)
	table.insert(cleanups, Lifecycle.start({ role = role, pushEvent = Net.pushEvent }))
end

local function startSync()
	Applier.onRootsChanged = Watcher.setRoots
	Watcher.start()
	Net.start(config)
end

local function stopSync()
	Net.stop()
	Watcher.stop()
end

-- Plugin settings are shared across the DataModels of one Studio, so this is the
-- stop path that still works when the play session's Net loop is wedged.
local function startStopMonitor(): () -> ()
	local monitoring = true
	local seen = plugin:GetSetting(SETTING_STOP_TOKEN)
	task.spawn(function()
		while monitoring do
			task.wait(STOP_POLL_SECONDS)
			if not monitoring then
				break
			end
			local token = plugin:GetSetting(SETTING_STOP_TOKEN)
			if token ~= nil and token ~= seen then
				seen = token
				pcall(function()
					RunService:Stop()
				end)
			end
		end
	end)
	return function()
		monitoring = false
	end
end

if role == "client" then
	Broker.startClient()
	table.insert(cleanups, Broker.stop)
elseif role == "server" then
	Broker.startHost()
	Dispatcher.setClientRouter(Broker.toClient)
	startLifecycle()
	Net.start(config)
	table.insert(cleanups, startStopMonitor())
	table.insert(cleanups, Net.stop)
	table.insert(cleanups, Broker.stop)
else
	local enabled = readEnabled()
	local toolbar = plugin:CreateToolbar("OGSync")
	local button = toolbar:CreateButton(
		"OGSyncToggle",
		string.format("OGSync %s — show the connection panel", Version),
		"",
		"OGSync"
	)
	button.ClickableWhenViewportHidden = true

	local function setConnected(on: boolean)
		enabled = on
		plugin:SetSetting(SETTING_ENABLED, on)
		Panel.setState({ connected = on })
		if on then
			startSync()
		else
			stopSync()
		end
	end

	local function setPort(newPort: number)
		plugin:SetSetting(SETTING_PORT, newPort)
		config.port = newPort
		Panel.setState({ port = newPort })
		if Net.isRunning() then
			stopSync()
			startSync()
		end
	end

	Panel.start({
		plugin = plugin,
		version = Version,
		port = port,
		connected = enabled,
		pushEvent = Net.pushEvent,
		setConnected = setConnected,
		setPort = setPort,
		onVisibility = function(visible: boolean)
			button:SetActive(visible)
		end,
	})
	Net.setObserver(Panel.setState)
	Applier.onSyncState = Panel.setState
	button.Click:Connect(Panel.toggle)

	startLifecycle()
	if enabled then
		startSync()
	end
	table.insert(cleanups, stopSync)
	table.insert(cleanups, Panel.stop)
	table.insert(cleanups, function()
		Net.setObserver(nil)
		Applier.onSyncState = nil
	end)
end

plugin.Unloading:Connect(function()
	for _, cleanup in cleanups do
		pcall(cleanup)
	end
end)
