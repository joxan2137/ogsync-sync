--!strict
-- Path → content hash of every script under the services a playtest copies.
-- The daemon compares the play server's map with the edit DataModel's to flag
-- stale code. Hashing a large place takes long enough to trip Studio's "plugin
-- is not responding" watchdog, so work yields every batch.

local Hash = require(script.Parent.Hash)
local Path = require(script.Parent.Path)

local ScriptHashes = {}

ScriptHashes.ROOTS = {
	"Workspace", "ReplicatedFirst", "ReplicatedStorage", "ServerScriptService",
	"ServerStorage", "StarterGui", "StarterPack", "StarterPlayer",
}
ScriptHashes.MAX_SCRIPTS = 5000

local BATCH_SCRIPTS = 100
local BATCH_BYTES = 262144

export type Result = { hashes: { [string]: string }, total: number, truncated: boolean }

function ScriptHashes.collect(root: Instance): Result
	local hashes: { [string]: string } = {}
	local total = 0
	local truncated = false
	local batchScripts = 0
	local batchBytes = 0
	for _, serviceName in ScriptHashes.ROOTS do
		local service = root:FindFirstChild(serviceName)
		if service == nil then
			continue
		end
		for _, inst in service:GetDescendants() do
			if not inst:IsA("LuaSourceContainer") then
				continue
			end
			local ok, source = pcall(function(): string
				return (inst :: any).Source
			end)
			if not ok or type(source) ~= "string" then
				continue
			end
			total += 1
			if total > ScriptHashes.MAX_SCRIPTS then
				truncated = true
				continue
			end
			hashes[Path.of(inst)] = Hash.content(source)
			batchScripts += 1
			batchBytes += #source
			if batchScripts >= BATCH_SCRIPTS or batchBytes >= BATCH_BYTES then
				batchScripts = 0
				batchBytes = 0
				task.wait()
			end
		end
	end
	return { hashes = hashes, total = total, truncated = truncated }
end

return ScriptHashes
