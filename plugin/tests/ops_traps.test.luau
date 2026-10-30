--!nonstrict
-- Trap guards on the ops side: binary-safe staged script writes with read-back
-- verification, eval job generations, one-recording-per-write, and transform
-- planning from original pivots. Run from the repo root:
-- `lune run plugin/tests/ops_traps.test`.

local process = require("@lune/process")
local roblox = require("@lune/roblox")
local Harness = require("./harness")

local SSS = "game.ServerScriptService"

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

local function errorOf(fn: () -> ()): string?
	local ok, err = pcall(fn)
	return if ok then nil else tostring(err)
end

local function newEnv()
	local env = Harness.new()
	env.globals.CFrame = roblox.CFrame
	env.globals.Vector3 = roblox.Vector3
	env.globals.Enum.FinishRecordingOperation = { Commit = "Commit", Cancel = "Cancel" }
	return env
end

local function newScript(env, name: string, source: string)
	local inst = env.newInstance("ModuleScript", name, env.game:GetService("ServerScriptService"))
	inst.Source = source
	return inst
end

-- ------------------------------------------------------------------ base64

local function testBase64()
	local Source = newEnv().load("Util/Source")
	check("empty base64", Source.decodeBase64("") == "")
	check("one pad byte", Source.decodeBase64("Zm8=") == "fo")
	check("two pad bytes", Source.decodeBase64("Zg==") == "f")
	check("no padding", Source.decodeBase64("Zm9v") == "foo")
	check("binary bytes survive", Source.decodeBase64("AAEC/w==") == "\0\1\2\255")
	check("bad length refused", errorOf(function()
		Source.decodeBase64("abc")
	end) ~= nil)
	check("bad alphabet refused", errorOf(function()
		Source.decodeBase64("ab!d")
	end) ~= nil)
end

-- ------------------------------------------------------------------ source transport

local function testSourceTake()
	local env = newEnv()
	local Source = env.load("Util/Source")
	local Hash = env.load("Util/Hash")

	-- "a\r\nb" in base64; the plugin normalizes after decoding.
	local text, hash = Source.take({ source_b64 = "YQ0KYg==", source_hash = Hash.content("a\nb") }, "source")
	check("inline b64 decodes to LF", text == "a\nb", string.format("%q", tostring(text)))
	check("take returns the verified hash", hash == Hash.content("a\nb"))

	local corrupted = errorOf(function()
		Source.take({ source_b64 = "YQ0KYg==", source_hash = "0000000000000000" }, "source")
	end)
	check("hash mismatch refused", corrupted ~= nil and string.find(corrupted, "corrupted", 1, true) ~= nil, corrupted)

	Source.stage({ upload = "u1", index = 2, total = 2, data = "dw==" })
	local early = errorOf(function()
		Source.take({ source_upload = "u1" }, "source")
	end)
	check("incomplete upload refused", early ~= nil and string.find(early, "1 of 2", 1, true) ~= nil, early)
	Source.stage({ upload = "u1", index = 1, total = 2, data = "bG9u" })
	local staged = Source.take({ source_upload = "u1", source_hash = Hash.content("lonw") }, "source")
	check("out-of-order chunks reassemble", staged == "lonw", tostring(staged))
	check("upload consumed once", errorOf(function()
		Source.take({ source_upload = "u1" }, "source")
	end) ~= nil)
	check("mismatched chunk count refused", errorOf(function()
		Source.stage({ upload = "u2", index = 1, total = 2, data = "" })
		Source.stage({ upload = "u2", index = 2, total = 3, data = "" })
	end) ~= nil)

	check("absent field yields nil", Source.take({}, "source") == nil)
	check("plain field still accepted", Source.take({ new = "x\r\n" }, "new") == "x\n")
end

local function testSourceWrite()
	local env = newEnv()
	local Source = env.load("Util/Source")
	local Hash = env.load("Util/Hash")

	local closed = newScript(env, "Closed", "old")
	local result = Source.write(closed, "new\n")
	check("closed script written", closed.Source == "new\n")
	check("closed write verified via Source", result.hash == Hash.content("new\n") and result.editor == false)

	local open = newScript(env, "Open", "old")
	env.openDocument(open, "old")
	local viaEditor = Source.write(open, "edited\n")
	check("open document verified via the editor", viaEditor.editor == true)

	local editor = env.game:GetService("ScriptEditorService")
	rawset(editor, "UpdateSourceAsync", function() end)
	local stuck = errorOf(function()
		Source.write(open, "never lands\n")
	end)
	check("a write that did not stick is reported", stuck ~= nil and string.find(stuck, "did not stick", 1, true) ~= nil, stuck)
end

local function testScriptOps()
	local env = newEnv()
	local ops = env.ops("Ops/Script")
	local Hash = env.load("Util/Hash")
	newScript(env, "Big", "")
	local body = "return [[\nlong\n]]"

	-- Base64 of `body` split across two staged chunks.
	ops["script.stage"]({ upload = "big", index = 1, total = 2, data = "cmV0dXJuIFtb" })
	ops["script.stage"]({ upload = "big", index = 2, total = 2, data = "CmxvbmcKXV0=" })
	local edited = ops["script.edit"]({ path = `{SSS}.Big`, source_upload = "big", source_hash = Hash.content(body) })
	check("staged edit writes the exact text", env.game:GetService("ServerScriptService"):FindFirstChild("Big").Source == body)
	check("edit returns the verified hash", edited.hash == Hash.content(body) and edited.verified == true)

	local created = ops["script.edit"]({ path = `{SSS}.Fresh`, source_b64 = "cmV0dXJuIDE=", class = "ModuleScript" })
	check("b64 source creates a missing script", created.created == true and created.hash == Hash.content("return 1"))
end

-- ------------------------------------------------------------------ jobs

local function testJobs()
	local env = newEnv()
	local Jobs = env.load("Ops/Run/Jobs")
	local registry = Jobs.new("n1")

	local first = registry:start({ key = "sampler", vm = "plugin", context = "edit" })
	local fired = 0
	local staleTimer = registry:guard(first, function()
		fired += 1
	end)
	local cancelled = 0
	first.onCancel = function()
		cancelled += 1
	end

	local second = registry:start({ key = "sampler", vm = "plugin", context = "edit" })
	check("generations increase", second.gen > first.gen)
	check("superseded job is cancelled", first.status == "cancelled" and first.cancelled == true)
	check("superseded job's thread is cancelled once", cancelled == 1)
	check("superseded reason names the successor", string.find(first.err, "superseded by job " .. second.id, 1, true) ~= nil)
	staleTimer()
	check("stale timer from the old generation is a no-op", fired == 0)
	check("new job is current", registry:isCurrent(second))

	check("late finish of a cancelled job is ignored", registry:finish(first, true, { 1 }) == false)
	check("cancelled job keeps no returns", first.returns == nil)
	check("finish settles a running job", registry:finish(second, true, { 42 }) == true)
	check("a job finishes only once", registry:finish(second, false, "again") == false and second.status == "done")

	local freshTimer = 0
	registry:guard(second, function()
		freshTimer += 1
	end)()
	check("a finished, still-current job's timer fires", freshTimer == 1)

	local unkeyed = registry:start({ vm = "game", context = "server" })
	registry:emit(unkeyed, "info", "hello")
	check("emit appends output", #unkeyed.output == 1 and unkeyed.output[1].text == "hello")
	registry:emit(unkeyed, "info", string.rep("x", 200 * 1024))
	check("oversized output is counted as dropped", unkeyed.dropped == 1)
	registry:cancel(unkeyed, "by request")
	registry:emit(unkeyed, "info", "after")
	check("cancelled jobs take no more output", #unkeyed.output == 1)

	local snapshot = registry:snapshot(second)
	check("snapshot carries vm, gen and status", snapshot.vm == "plugin" and snapshot.gen == second.gen and snapshot.status == "done")
	check("snapshot carries the registry nonce", snapshot.nonce == "n1")
	check("take forgets a job", registry:take(second.id) == second and registry:get(second.id) == nil)

	local burst = Jobs.new("n2")
	for _ = 1, 40 do
		burst:finish(burst:start({ vm = "plugin", context = "edit" }), true, {})
	end
	check("only the newest 32 finished jobs are kept", #burst:list() == 32 and burst:get("1") == nil and burst:get("40") ~= nil)
end

-- ------------------------------------------------------------------ recording

local function testRecording()
	local env = newEnv()
	local history = env.game:GetService("ChangeHistoryService")
	local finished = {}
	local nextId: string? = "rec1"
	rawset(history, "TryBeginRecording", function()
		return nextId
	end)
	rawset(history, "FinishRecording", function(_self, id, operation)
		table.insert(finished, { id = id, op = operation })
	end)
	local Recording = env.load("Util/Recording")

	check("success returns the value", Recording.run("set", function()
		return 7
	end) == 7)
	check("success commits", finished[1] ~= nil and finished[1].id == "rec1" and finished[1].op == "Commit")

	local thrown = errorOf(function()
		Recording.run("set", function()
			error("half applied", 0)
		end)
	end)
	check("failure rethrows", thrown == "half applied", thrown)
	check("failure cancels the recording", finished[2] ~= nil and finished[2].op == "Cancel")

	nextId = nil
	local ran = false
	Recording.run("set", function()
		ran = true
	end)
	check("no recording available still writes", ran and #finished == 2)

	-- A write that yields holds the lock; a second write waits for it, so a
	-- Cancel of the first can never roll back the second.
	nextId = "rec2"
	local order = {}
	local first = coroutine.create(function()
		Recording.run("first", function()
			table.insert(order, "first:start")
			coroutine.yield()
			table.insert(order, "first:end")
		end)
	end)
	local second = coroutine.create(function()
		Recording.run("second", function()
			table.insert(order, "second")
		end)
	end)
	coroutine.resume(first)
	coroutine.resume(second)
	check("second write waits while the first yields", table.concat(order, ",") == "first:start", table.concat(order, ","))
	coroutine.resume(first)
	check("second write runs after the first finishes", table.concat(order, ",") == "first:start,first:end,second", table.concat(order, ","))
end

-- ------------------------------------------------------------------ transform

local function near(a, b): boolean
	return (a - b).Magnitude < 1e-4
end

local function testTransform()
	local env = newEnv()
	local Transform = env.load("Util/Transform")
	local CFrame, Vector3 = roblox.CFrame, roblox.Vector3
	local workspace = env.game:GetService("Workspace")

	check("to + move refused", errorOf(function()
		Transform.decodeSpec({ to = { 0, 0, 0 }, move = { 1, 0, 0 } })
	end) ~= nil)
	check("empty spec refused", errorOf(function()
		Transform.decodeSpec({})
	end) ~= nil)
	check("bad vector refused", errorOf(function()
		Transform.decodeSpec({ move = { 1, 2 } })
	end) ~= nil)

	local a = env.newInstance("Part", "A", workspace)
	local b = env.newInstance("Part", "B", workspace)
	local child = env.newInstance("Part", "Child", a)
	local fromA = CFrame.new(0, 0, 0)
	local fromB = CFrame.new(10, 0, 0)

	local moveSpec = Transform.decodeSpec({ move = { 0, 5, 0 } })
	local steps, skipped = Transform.plan({
		{ spec = moveSpec, members = { { inst = a, from = fromA }, { inst = b, from = fromB }, { inst = child, from = fromA } } },
	})
	check("each target computed from its own original pivot", #steps == 3
		and near(steps[1].to.Position, Vector3.new(0, 5, 0))
		and near(steps[2].to.Position, Vector3.new(10, 5, 0)))
	check("a part under a listed part moves itself (BasePart:PivotTo leaves children)", #skipped == 0 and steps[3].inst == child)

	local hut = env.newInstance("Model", "Hut", workspace)
	local door = env.newInstance("Part", "Door", hut)
	local _, riders = Transform.plan({
		{ spec = moveSpec, members = { { inst = hut, from = fromA }, { inst = door, from = fromB } } },
	})
	check("a listed descendant of a listed Model rides with it", #riders == 1 and riders[1].inst == door and riders[1].ancestor == hut)

	local spin = Transform.decodeSpec({ rotate = { 0, 90, 0 } })
	local onPivot = Transform.plan({ { spec = spin, members = { { inst = b, from = fromB } } } })
	check("rotation about own pivot keeps position", near(onPivot[1].to.Position, fromB.Position))
	local _, yaw = onPivot[1].to:ToOrientation()
	check("rotation applied in degrees", math.abs(math.deg(yaw) - 90) < 1e-3, tostring(math.deg(yaw)))

	local group = Transform.decodeSpec({ rotate = { 0, 180, 0 }, origin = "center" })
	local swapped = Transform.plan({ { spec = group, members = { { inst = a, from = fromA }, { inst = b, from = fromB } } } })
	check("rotation about the group center swaps ends", near(swapped[1].to.Position, Vector3.new(10, 0, 0))
		and near(swapped[2].to.Position, Vector3.new(0, 0, 0)))

	local absolute = Transform.plan({
		{ spec = Transform.decodeSpec({ to = { 1, 2, 3 } }), members = { { inst = a, from = CFrame.fromEulerAnglesYXZ(0, 1, 0) } } },
	})
	check("absolute position keeps rotation", near(absolute[1].to.Position, Vector3.new(1, 2, 3))
		and near(absolute[1].to.LookVector, CFrame.fromEulerAnglesYXZ(0, 1, 0).LookVector))

	local described = Transform.describe(CFrame.new(1.23456, 0, 0) * CFrame.fromEulerAnglesYXZ(0, math.rad(45), 0))
	check("describe rounds position and orientation", described[1][1] == 1.235 and described[2][2] == 45, tostring(described[2][2]))
end

testBase64()
testSourceTake()
testSourceWrite()
testScriptOps()
testJobs()
testRecording()
testTransform()

print(`ops traps: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
