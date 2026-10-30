--!strict
-- Script source transport and verified writes. Sources cross the wire as base64
-- of their UTF-8 bytes, so JSON escaping cannot mangle NULs, lone CRs or long
-- brackets; large ones arrive as staged chunks; every write is read back (from
-- the open editor document when there is one) and hash-checked.

local ScriptEditorService = game:GetService("ScriptEditorService")

local Hash = require(script.Parent.Hash)
local Path = require(script.Parent.Path)

local STAGE_TTL_SECONDS = 120
local MAX_UPLOADS = 16

type Upload = { chunks: { string }, total: number, received: number, touched: number }

export type WriteResult = { hash: string, editor: boolean }

local Source = {}

local uploads: { [string]: Upload } = {}

local B64_VALUES: { [number]: number } = {}
do
	local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	for index = 1, #alphabet do
		B64_VALUES[string.byte(alphabet, index)] = index - 1
	end
end

-- LF-only, matching normalizeSource() in server/src/proto/types.ts: the daemon
-- hashes the normalized text, so the plugin must write and hash the same bytes.
function Source.toLf(text: string): string
	if string.find(text, "\r", 1, true) == nil then
		return text
	end
	local lf = string.gsub(text, "\r\n", "\n")
	return (string.gsub(lf, "\r", "\n"))
end

function Source.decodeBase64(text: string): string
	local length = #text
	if length % 4 ~= 0 then
		error(string.format("base64 payload length %d is not a multiple of 4", length), 0)
	end
	if length == 0 then
		return ""
	end
	local padding = if string.sub(text, -2) == "==" then 2 elseif string.sub(text, -1) == "=" then 1 else 0
	local out = buffer.create(length // 4 * 3 - padding)
	local size = buffer.len(out)
	local offset = 0
	for index = 1, length, 4 do
		local a, b, c, d = string.byte(text, index, index + 3)
		local va, vb = B64_VALUES[a], B64_VALUES[b]
		local vc = if c == 61 then 0 else B64_VALUES[c]
		local vd = if d == 61 then 0 else B64_VALUES[d]
		if va == nil or vb == nil or vc == nil or vd == nil then
			error(string.format("invalid base64 character near offset %d", index), 0)
		end
		local packed = va * 262144 + vb * 4096 + vc * 64 + vd
		buffer.writeu8(out, offset, bit32.rshift(packed, 16))
		if offset + 1 < size then
			buffer.writeu8(out, offset + 1, bit32.band(bit32.rshift(packed, 8), 255))
		end
		if offset + 2 < size then
			buffer.writeu8(out, offset + 2, bit32.band(packed, 255))
		end
		offset += 3
	end
	return buffer.tostring(out)
end

local function pruneUploads()
	local now = os.clock()
	local live = 0
	for id, upload in uploads do
		if now - upload.touched > STAGE_TTL_SECONDS then
			uploads[id] = nil
		else
			live += 1
		end
	end
	if live < MAX_UPLOADS then
		return
	end
	local oldestId, oldest = nil, math.huge
	for id, upload in uploads do
		if upload.touched < oldest then
			oldestId, oldest = id, upload.touched
		end
	end
	if oldestId ~= nil then
		uploads[oldestId] = nil
	end
end

-- script.stage: one base64 chunk of a large source. Chunks may arrive in any
-- order; the op that consumes the upload checks it is complete.
function Source.stage(args: any): any
	local id = args.upload
	local index = tonumber(args.index)
	local total = tonumber(args.total)
	if type(id) ~= "string" or index == nil or total == nil or type(args.data) ~= "string" then
		error("script.stage needs upload, index, total and data", 0)
	end
	if index < 1 or index > total then
		error(string.format("chunk index %d outside 1..%d", index, total), 0)
	end
	local upload = uploads[id]
	if upload == nil then
		pruneUploads()
		upload = { chunks = {}, total = total, received = 0, touched = os.clock() }
		uploads[id] = upload
	elseif upload.total ~= total then
		error(string.format("upload %s was staged with %d chunks, not %d", id, upload.total, total), 0)
	end
	local staged = upload :: Upload
	if staged.chunks[index] == nil then
		staged.received += 1
	end
	staged.chunks[index] = args.data
	staged.touched = os.clock()
	return { upload = id, received = staged.received, total = staged.total }
end

-- The text an op carries for `field`: `<field>_b64` inline, `<field>_upload`
-- staged, or plain `<field>` from older daemons. `<field>_hash`, when present,
-- must match the LF-normalized text. Returns nil when the op carries none.
function Source.take(args: any, field: string): (string?, string?)
	local encoded: string? = nil
	local uploadId = args[field .. "_upload"]
	if type(uploadId) == "string" then
		local upload = uploads[uploadId]
		if upload == nil then
			error(string.format("upload %s is unknown or expired (staged chunks live %ds)", uploadId, STAGE_TTL_SECONDS), 0)
		end
		if upload.received ~= upload.total then
			error(string.format("upload %s is incomplete: %d of %d chunks", uploadId, upload.received, upload.total), 0)
		end
		uploads[uploadId] = nil
		encoded = table.concat(upload.chunks)
	elseif type(args[field .. "_b64"]) == "string" then
		encoded = args[field .. "_b64"]
	end

	local text: string
	if encoded ~= nil then
		text = Source.toLf(Source.decodeBase64(encoded))
	elseif type(args[field]) == "string" then
		text = Source.toLf(args[field])
	else
		return nil, nil
	end

	local hash = Hash.content(text)
	local expected = args[field .. "_hash"]
	if type(expected) == "string" and expected ~= hash then
		error(string.format("%s arrived corrupted: hash %s, daemon sent %s", field, hash, expected), 0)
	end
	return text, hash
end

local function editorText(inst: Instance): string?
	local found, document = pcall(function()
		return ScriptEditorService:FindScriptDocument(inst)
	end)
	if not found or document == nil then
		return nil
	end
	local viaService, text = pcall(function(): string
		return (ScriptEditorService :: any):GetEditorSource(inst)
	end)
	if viaService and type(text) == "string" then
		return text
	end
	local viaDocument, documentText = pcall(function(): string
		return (document :: any):GetText()
	end)
	return if viaDocument and type(documentText) == "string" then documentText else nil
end

-- UpdateSourceAsync merges into an open editor document instead of being
-- overridden by it; the read-back then proves the editor holds what we wrote.
-- ChangeHistoryService never records script text, so no path here is undoable.
function Source.write(inst: Instance, text: string, hash: string?): WriteResult
	local expected = hash or Hash.content(text)
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return text
		end)
	end)
	if not ok then
		error("cannot write source of " .. Path.of(inst) .. ": " .. tostring(err), 0)
	end

	local fromEditor = editorText(inst)
	local readBack: string
	if fromEditor ~= nil then
		readBack = fromEditor
	else
		local readOk, current = pcall(function(): any
			return (inst :: any).Source
		end)
		if not readOk or type(current) ~= "string" then
			error("cannot read back source of " .. Path.of(inst) .. ": " .. tostring(current), 0)
		end
		readBack = current
	end

	local actual = Hash.content(Source.toLf(readBack))
	if actual ~= expected then
		error(
			string.format(
				"write to %s did not stick: %s holds %s, wrote %s",
				Path.of(inst),
				if fromEditor ~= nil then "the open editor" else "Source",
				actual,
				expected
			),
			0
		)
	end
	return { hash = expected, editor = fromEditor ~= nil }
end

return Source
