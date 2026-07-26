--!nonstrict
-- Guards that stop sync from destroying work: delete/create base-hash proof,
-- LF-only wire hashes, echo suppression bounds, ambiguous sibling paths and the
-- dot-path escape set. Run from the repo root: `lune run plugin/tests/sync_guards.test`.

local process = require("@lune/process")
local Harness = require("./harness")

local SSS = "game.ServerScriptService"
-- Hash.content("local a = 1\nlocal b = 2\n"), which is also
-- contentHash(normalizeSource(<the CRLF form>)) on the daemon side.
local CRLF_LF_HASH = "ac05379d25453ddf"

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

local function newSync()
	local env = Harness.new()
	local sync = {
		env = env,
		Applier = env.load("Sync/Applier"),
		Hash = env.load("Util/Hash"),
		Path = env.load("Util/Path"),
	}
	sync.container = env.game:GetService("ServerScriptService")
	sync.apply = function(change: any): any
		return sync.Applier.apply({ changes = { change } })[1]
	end
	sync.script = function(name: string, source: string): any
		local inst = env.newInstance("ModuleScript", name, sync.container)
		inst.Source = source
		return inst
	end
	return sync
end

-- ------------------------------------------------------------------ deletes

local function testDeleteGuards()
	local sync = newSync()
	local main = sync.script("Main", "return 1\n")
	local path = `{SSS}.Main`

	local stale = sync.apply({ kind = "delete", path = path, baseHash = "0000000000000000" })
	check("stale delete refused", stale.ok == false, `ok={tostring(stale.ok)}`)
	check("stale delete reports current hash", stale.conflictHash == sync.Hash.content("return 1\n"))
	check("stale delete keeps the script", sync.container:FindFirstChild("Main") == main)

	local unversioned = sync.apply({ kind = "delete", path = path })
	check("unversioned delete of live source refused", unversioned.ok == false)
	check("unversioned delete reports current hash", unversioned.conflictHash == sync.Hash.content("return 1\n"))
	check("unversioned delete keeps the script", sync.container:FindFirstChild("Main") == main)

	local forced = sync.apply({ kind = "delete", path = path, force = true })
	check("forced delete destroys", forced.ok == true and sync.container:FindFirstChild("Main") == nil)

	local matched = sync.script("Matched", "return 2\n")
	local matchedResult = sync.apply({
		kind = "delete",
		path = `{SSS}.Matched`,
		baseHash = sync.Hash.content("return 2\n"),
	})
	check(
		"matching baseHash delete destroys",
		matchedResult.ok == true and sync.container:FindFirstChild("Matched") == nil,
		tostring(matchedResult.err)
	)
	check("destroyed script is unparented", matched.Parent == nil)

	sync.script("Blank", "")
	local blank = sync.apply({ kind = "delete", path = `{SSS}.Blank` })
	check("unversioned delete of empty script allowed", blank.ok == true)

	local folder = sync.env.newInstance("Folder", "Bin", sync.container)
	local folderResult = sync.apply({ kind = "delete", path = `{SSS}.Bin` })
	check(
		"unversioned delete of folder allowed",
		folderResult.ok == true and folder.Parent == nil,
		tostring(folderResult.err)
	)
end

-- ------------------------------------------------------------------ creates

local function testCreateGuards()
	local sync = newSync()
	local existing = sync.script("Dup", "-- studio\n")
	local path = `{SSS}.Dup`

	local blind = sync.apply({ kind = "create", path = path, class = "ModuleScript", source = "-- fs\n" })
	check("create over existing instance refused", blind.ok == false)
	check("create reports current hash", blind.conflictHash == sync.Hash.content("-- studio\n"))
	check("create leaves source untouched", existing.Source == "-- studio\n")

	local matched = sync.apply({
		kind = "create",
		path = path,
		class = "ModuleScript",
		source = "-- fs\n",
		baseHash = sync.Hash.content("-- studio\n"),
	})
	check("create with matching baseHash writes", matched.ok == true, tostring(matched.err))
	check("create with matching baseHash applied source", existing.Source == "-- fs\n")

	local fresh = sync.apply({ kind = "create", path = `{SSS}.Fresh`, class = "ModuleScript", source = "-- new\n" })
	local created = sync.container:FindFirstChild("Fresh")
	check("create of a missing path still works", fresh.ok == true and created ~= nil, tostring(fresh.err))
	check("created source stored", created ~= nil and created.Source == "-- new\n")

	local staleWrite = sync.apply({
		kind = "write",
		path = `{SSS}.Fresh`,
		source = "-- other\n",
		baseHash = "0000000000000000",
	})
	check("stale write refused", staleWrite.ok == false and staleWrite.conflictHash == sync.Hash.content("-- new\n"))
	check("stale write leaves source untouched", created.Source == "-- new\n")
end

-- ------------------------------------------------------------------ CRLF

local function testCrlfHashing()
	local sync = newSync()
	local ops = sync.env.ops("Ops/Script")
	local crlf = "local a = 1\r\nlocal b = 2\r\n"
	local lf = "local a = 1\nlocal b = 2\n"
	local inst = sync.script("Windows", crlf)
	local path = `{SSS}.Windows`

	local read = ops["script.read"]({ path = path })
	check("script.read hashes the LF form", read.hash == CRLF_LF_HASH, read.hash)
	check("script.read strips CR from lines", table.concat(read.lines, "\n") == lf)
	check("rejoined lines hash to the reported hash", sync.Hash.content(table.concat(read.lines, "\n")) == read.hash)
	check("Applier.hashOf hashes the LF form", sync.Applier.hashOf(inst) == CRLF_LF_HASH)
	check("Applier.sourceOf returns the LF form", sync.Applier.sourceOf(inst) == lf)

	local rows = sync.Applier.snapshot({ roots = { SSS } })
	local row: any = nil
	for _, entry in rows do
		if entry.path == path then
			row = entry
		end
	end
	check("snapshot row exists", row ~= nil)
	check("snapshot hashes the LF form", row ~= nil and row.hash == CRLF_LF_HASH)

	local hashed = sync.Applier.hash({ paths = { path } })
	check("sync.hash hashes the LF form", hashed[1].hash == CRLF_LF_HASH)

	sync.env.openDocument(inst, crlf)
	check("open document hashes the LF form", sync.Applier.hashOf(inst) == CRLF_LF_HASH)

	local edited = ops["script.edit"]({ path = path, source = "x = 1\r\ny = 2\r\n" })
	check("script.edit hashes the LF form", edited.hash == sync.Hash.content("x = 1\ny = 2\n"), edited.hash)
	check("script.edit writes the LF form", sync.Applier.sourceOf(inst) == "x = 1\ny = 2\n")

	local applied = sync.apply({ kind = "write", path = path, source = crlf, baseHash = sync.Applier.hashOf(inst) })
	check("sync.apply reports the LF hash", applied.ok == true and applied.hash == CRLF_LF_HASH, tostring(applied.err))
	check("applied write echoes as the LF hash", sync.Applier.wasEcho(path, CRLF_LF_HASH))
end

-- ------------------------------------------------------------------ echoes

local function testContentEcho()
	local sync = newSync()
	sync.script("Echo", "")
	local path = `{SSS}.Echo`
	local hash = sync.Hash.content("print(1)\n")
	local other = sync.Hash.content("print(2)\n")

	sync.apply({ kind = "write", path = path, source = "print(1)\n" })
	check("applied write is an echo", sync.Applier.wasEcho(path, hash))
	check("same hash twice is still an echo", sync.Applier.wasEcho(path, hash))
	check("a different hash is not an echo", sync.Applier.wasEcho(path, other) == false)
	check("record dropped once the path really changed", sync.Applier.wasEcho(path, hash) == false)
end

local function testEchoBounds()
	local sync = newSync()
	local total = 600
	for index = 1, total do
		local name = `S{index}`
		sync.script(name, "")
		sync.apply({ kind = "write", path = `{SSS}.{name}`, source = `-- {index}\n` })
		sync.env.advance(0.001)
	end
	check("oldest echo evicted past the cap", sync.Applier.wasEcho(`{SSS}.S1`, sync.Hash.content("-- 1\n")) == false)
	check(
		"newest echo kept",
		sync.Applier.wasEcho(`{SSS}.S{total}`, sync.Hash.content(`-- {total}\n`)),
		"eviction dropped the newest record"
	)

	local aged = newSync()
	aged.script("Aged", "")
	aged.apply({ kind = "write", path = `{SSS}.Aged`, source = "a\n" })
	aged.env.advance(61)
	check("expired echo is not an echo", aged.Applier.wasEcho(`{SSS}.Aged`, aged.Hash.content("a\n")) == false)
	aged.script("Other", "")
	aged.apply({ kind = "write", path = `{SSS}.Other`, source = "b\n" })
	check("fresh echo after expiry still works", aged.Applier.wasEcho(`{SSS}.Other`, aged.Hash.content("b\n")))
end

local function testStructuralEcho()
	local sync = newSync()
	local path = `{SSS}.Added`
	sync.apply({ kind = "create", path = path, class = "ModuleScript", source = "x = 1\n" })
	check("create echo suppresses instAdded", sync.Applier.wasStructuralEcho("create", path))
	check("create echo does not suppress instRemoved", sync.Applier.wasStructuralEcho("delete", path) == false)
	check("create echo does not suppress instRenamed", sync.Applier.wasStructuralEcho("rename", path) == false)

	sync.env.advance(0.5)
	check("create echo still inside the window", sync.Applier.wasStructuralEcho("create", path))
	sync.env.advance(0.2)
	check("create echo expired past 600 ms", sync.Applier.wasStructuralEcho("create", path) == false)

	local deleted = `{SSS}.Gone`
	sync.script("Gone", "return 1\n")
	sync.apply({ kind = "delete", path = deleted, baseHash = sync.Hash.content("return 1\n") })
	check("delete echo suppresses instRemoved", sync.Applier.wasStructuralEcho("delete", deleted))
	sync.env.advance(0.7)
	check(
		"a user delete after the window is reported",
		sync.Applier.wasStructuralEcho("delete", deleted) == false
	)
end

-- ------------------------------------------------------------------ roots

local function testSnapshotKeepsRoots()
	local sync = newSync()
	local seatings = 0
	sync.Applier.onRootsChanged = function()
		seatings += 1
	end
	local root = sync.env.newInstance("Folder", "Src", sync.container)
	sync.env.newInstance("ModuleScript", "Main", root)
	local rootPath = `{SSS}.Src`

	sync.Applier.snapshot({ roots = { rootPath } })
	check("first snapshot seats roots", seatings == 1, `seatings={seatings}`)
	sync.Applier.snapshot({ roots = { rootPath } })
	sync.Applier.snapshot({ roots = { rootPath } })
	check("later snapshots leave the watcher alone", seatings == 1, `seatings={seatings}`)
	sync.Applier.snapshot({ roots = { rootPath, "game.ReplicatedStorage" } })
	check("a changed root set re-seats", seatings == 2, `seatings={seatings}`)

	root:Destroy()
	sync.env.newInstance("Folder", "Src", sync.container)
	sync.Applier.snapshot({ roots = { rootPath, "game.ReplicatedStorage" } })
	check("a root replaced in Studio re-seats", seatings == 3, `seatings={seatings}`)
	sync.Applier.onRootsChanged = nil
end

-- ------------------------------------------------------------------ paths

local function testAmbiguousSiblings()
	local sync = newSync()
	local folder = sync.env.newInstance("Folder", "Shared", sync.container)
	local twinA = sync.env.newInstance("ModuleScript", "Twin", folder)
	local twinB = sync.env.newInstance("ModuleScript", "Twin", folder)
	local solo = sync.env.newInstance("ModuleScript", "Solo", folder)
	local nested = sync.env.newInstance("ModuleScript", "Nested", twinA)

	local pathA, ambiguousA = sync.Path.ofChecked(twinA)
	local _, ambiguousB = sync.Path.ofChecked(twinB)
	local soloPath, ambiguousSolo = sync.Path.ofChecked(solo)
	local _, ambiguousNested = sync.Path.ofChecked(nested)
	check("twin path flagged", ambiguousA and ambiguousB)
	check("unique sibling not flagged", ambiguousSolo == false)
	check("descendant of a twin flagged", ambiguousNested)
	check("Path.of unchanged", pathA == `{SSS}.Shared.Twin` and sync.Path.of(twinA) == pathA)
	check("unique path unchanged", soloPath == `{SSS}.Shared.Solo`)

	local rows = sync.Applier.snapshot({ roots = { SSS } })
	local twinRows = 0
	local soloRow: any = nil
	for _, row in rows do
		if row.path == pathA then
			twinRows += 1
			check("snapshot marks the twin row", row.ambiguous == true)
		elseif row.path == soloPath then
			soloRow = row
		end
	end
	check("both twins reported", twinRows == 2, `twinRows={twinRows}`)
	check("unique row carries no flag", soloRow ~= nil and soloRow.ambiguous == nil)
end

local function testQuoteRoundTrip()
	local sync = newSync()
	local storage = sync.env.game:GetService("ReplicatedStorage")
	local names = {
		"plain",
		"123",
		"a\"b",
		"a\\b",
		"a\\nb",
		"back\\\\slashes",
		"My.Part",
		"with space",
		"[bracket]",
		"line1\nline2",
		"héllo ✓",
		"quote\"and\\both",
	}
	for _, name in names do
		local inst = sync.env.newInstance("ModuleScript", name, storage)
		local path = sync.Path.of(inst)
		local _, leaf, err = sync.Path.split(path)
		check(`split round-trips {string.format("%q", name)}`, leaf == name, `{tostring(leaf)} err={tostring(err)}`)
		check(`resolve round-trips {string.format("%q", name)}`, sync.Path.resolve(path) == inst)
	end

	local _, backslashN = sync.Path.split('game.ReplicatedStorage["a\\nb"]')
	check("\\n is a literal backslash, not a newline", backslashN == "a\\nb", string.format("%q", tostring(backslashN)))
	local _, quoted = sync.Path.split('game.ReplicatedStorage["a\\"b"]')
	check("\\\" unescapes to a quote", quoted == "a\"b", string.format("%q", tostring(quoted)))
	local _, backslash = sync.Path.split('game.ReplicatedStorage["a\\\\b"]')
	check("\\\\ unescapes to one backslash", backslash == "a\\b", string.format("%q", tostring(backslash)))
	local _, tabbed = sync.Path.split('game.ReplicatedStorage["a\\tb"]')
	check("\\t stays a literal backslash + t", tabbed == "a\\tb", string.format("%q", tostring(tabbed)))
end

testDeleteGuards()
testCreateGuards()
testCrlfHashing()
testContentEcho()
testEchoBounds()
testStructuralEcho()
testSnapshotKeepsRoots()
testAmbiguousSiblings()
testQuoteRoundTrip()

print(`sync guards: {passed} passed, {failed} failed`)
if failed > 0 then
	process.exit(1)
end
