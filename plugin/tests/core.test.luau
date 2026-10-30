--!nonstrict
-- Transport and lifecycle guards: the port scan order, redelivered-job dedupe,
-- playtest state derivation, chunked script hashing and the wait.check probe.
-- Run from the repo root: `lune run plugin/tests/core.test`.

local process = require("@lune/process")
local Harness = require("./harness")

local passed = 0
local failed = 0

local function check(name: string, ok: boolean, detail: string?)
	if ok then
		passed += 1
		return
	end
	failed += 1
	print(`FAIL {name}{if detail ~= nil then ` — {detail}` else ""}`)
end

local function testPorts()
	local Ports = Harness.new().load("Util/Ports")
	local order = Ports.order(13667)
	check("preferred port goes first", order[1] == 13667)
	check("preferred port is not repeated", #order == #Ports.CANDIDATES, `{#order}`)
	check("unknown preference is prepended", Ports.order(5000)[1] == 5000 and #Ports.order(5000) == #Ports.CANDIDATES + 1)
	check("default order starts at 3667", Ports.order(nil)[1] == 3667)
end

local function testJobLog()
	local JobLog = Harness.new().load("Util/JobLog")
	local log = JobLog.new(2)
	check("first sight runs", JobLog.begin(log, "a") == "new")
	check("redelivery while running is skipped", JobLog.begin(log, "a") == "running")
	JobLog.finish(log, "a")
	check("redelivery after finishing is skipped", JobLog.begin(log, "a") == "done")
	JobLog.begin(log, "b")
	JobLog.begin(log, "c")
	check("oldest finished ids are evicted at capacity", JobLog.begin(log, "a") == "new")
	check("running ids are never evicted", JobLog.begin(log, "b") == "running" and JobLog.begin(log, "c") == "running")
end

local function testPlayState()
	local env = Harness.new()
	local PlayState = env.load("Util/PlayState")
	local derive = PlayState.derive
	check("idle", derive(false, false, "idle").state == "idle")
	check("start in flight", derive(false, false, "starting").state == "starting")
	local play = derive(false, true, "idle")
	check("active play test is running in play mode", play.state == "running" and play.mode == "play")
	local run = derive(true, false, "idle")
	check("run mode in the edit DataModel", run.state == "running" and run.mode == "run")
	check("stop in flight while still running", derive(true, false, "stopping").state == "stopping")

	PlayState.setIntent("starting")
	PlayState.setTestActive(true)
	check("snapshot clears a start once the test is up", PlayState.snapshot(false).state == "running")
	PlayState.setIntent("stopping")
	PlayState.setTestActive(false)
	check("a finished test ends the stop", PlayState.snapshot(false).state == "idle")

	PlayState.setTestActive(true)
	PlayState.setIntent("stopping")
	check("a stop in flight reads stopping", PlayState.snapshot(false).state == "stopping")
	env.advance(21)
	check("an unconfirmed stop expires back to running", PlayState.snapshot(false).state == "running")
	PlayState.setTestActive(false)

	local fired = 0
	local stop = PlayState.onChange(function()
		fired += 1
	end)
	PlayState.setTestActive(true)
	PlayState.setTestActive(true)
	stop()
	PlayState.setTestActive(false)
	check("listeners fire once per real change and stop on unsubscribe", fired == 1, `{fired}`)
end

local function testScriptHashes()
	local env = Harness.new()
	local ScriptHashes = env.load("Util/ScriptHashes")
	local Hash = env.load("Util/Hash")
	local sss = env.game:GetService("ServerScriptService")
	local rs = env.game:GetService("ReplicatedStorage")
	local main = env.newInstance("Script", "Main", sss)
	main.Source = "print(1)\n"
	local folder = env.newInstance("Folder", "Shared", rs)
	local util = env.newInstance("ModuleScript", "Util", folder)
	util.Source = "return {}\n"
	env.newInstance("Part", "NotAScript", rs)

	local result = ScriptHashes.collect(env.game)
	check("hashes every script under the copied services", result.total == 2, `{result.total}`)
	check(
		"keys are dot-paths, values content hashes",
		result.hashes["game.ServerScriptService.Main"] == Hash.content("print(1)\n")
			and result.hashes["game.ReplicatedStorage.Shared.Util"] == Hash.content("return {}\n")
	)
	check("not truncated", result.truncated == false)

	ScriptHashes.MAX_SCRIPTS = 1
	local capped = ScriptHashes.collect(env.game)
	local kept = 0
	for _ in capped.hashes do
		kept += 1
	end
	check("caps the map and says so", capped.truncated and kept == 1 and capped.total == 2)
end

local function testWaitCheck()
	local env = Harness.new()
	local ok, ops = pcall(env.ops, "Ops/Wait")
	if not ok then
		check("Ops/Wait loads under the harness", false, tostring(ops))
		return
	end
	local ws = env.game:GetService("Workspace")
	local door = env.newInstance("Part", "Door", ws)
	local attributes = { Open = false }
	rawset(door, "GetAttribute", function(_self, name)
		return attributes[name]
	end)

	local missing = ops["wait.check"]({ kind = "instance", path = "game.Workspace.Window" })
	check("missing instance is not met", missing.met == false and missing.exists == false)
	check("present instance is met", ops["wait.check"]({ kind = "instance", path = "game.Workspace.Door" }).met == true)

	local closed = ops["wait.check"]({ kind = "attribute", path = "game.Workspace.Door", name = "Open", value = true })
	check("attribute value mismatch is not met", closed.met == false and closed.value == false)
	attributes.Open = true
	local open = ops["wait.check"]({ kind = "attribute", path = "game.Workspace.Door", name = "Open", value = true })
	check("attribute value match is met", open.met == true)
	local exists = ops["wait.check"]({ kind = "attribute", path = "game.Workspace.Door", name = "Open" })
	check("no value means the attribute only has to exist", exists.met == true)
	local absent = ops["wait.check"]({ kind = "attribute", path = "game.Workspace.Door", name = "Locked" })
	check("an unset attribute does not exist", absent.met == false)
end

testPorts()
testJobLog()
testPlayState()
testScriptHashes()
testWaitCheck()

print(`core: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
