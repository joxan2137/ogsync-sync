--!strict
-- Wire-size guards. docs/PROTOCOL.md caps one result at 1 MB; oversized lists
-- are truncated and marked with {truncated = true, total = N}.

local HttpService = game:GetService("HttpService")

local Output = {}

Output.MAX_BYTES = 1048576
local ENVELOPE_RESERVE = 2048

function Output.jsonSize(value: any): number?
	if value == nil then
		return 4
	end
	local ok, encoded = pcall(function(): string
		return HttpService:JSONEncode(value)
	end)
	if not ok then
		return nil
	end
	return #(encoded :: string)
end

function Output.marker(total: number): { truncated: boolean, total: number }
	return { truncated = true, total = total }
end

function Output.capList(items: {any}, maxBytes: number?): ({any}, boolean, number)
	local budget = (maxBytes or Output.MAX_BYTES) - ENVELOPE_RESERVE
	local kept: {any} = {}
	local total = #items
	local truncated = false
	for index, item in items do
		local size = Output.jsonSize(item)
		-- Unserializable items stop the list so the kept part stays a prefix
		-- (daemon cursors resume from the count we report).
		if size == nil or size + 1 > budget then
			truncated = true
			break
		end
		budget -= size + 1
		kept[index] = item
	end
	return kept, truncated, total
end

-- Whole-result guard used by Dispatcher: arrays get capped + marked, anything
-- else that does not fit becomes an error the daemon can report honestly.
function Output.capResult(value: any, maxBytes: number?): (any, string?)
	if value == nil then
		return nil, nil
	end
	local max = maxBytes or Output.MAX_BYTES
	local size = Output.jsonSize(value)
	if size ~= nil and size <= max - ENVELOPE_RESERVE then
		return value, nil
	end
	if type(value) == "table" and #(value :: {any}) > 0 then
		local kept, truncated, total = Output.capList(value :: {any}, max)
		if truncated then
			table.insert(kept, Output.marker(total))
		end
		local keptSize = Output.jsonSize(kept)
		if keptSize ~= nil and keptSize <= max then
			return kept, nil
		end
	end
	if size == nil then
		return nil, "serialization failed: result is not JSON-encodable"
	end
	return nil, string.format("result too large: %d bytes (cap %d)", size, max)
end

return Output
