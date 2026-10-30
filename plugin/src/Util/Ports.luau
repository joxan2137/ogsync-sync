--!strict
-- Ports the daemon may bind, in its own preference order. MUST match
-- CANDIDATE_PORTS in server/src/proto/types.ts: the plugin finds a daemon that
-- moved (excluded port range, restart) by scanning exactly this list, and never
-- stays pinned to a port that stopped answering.

local Ports = {}

Ports.CANDIDATES = { 3667, 3668, 3669, 13667, 23667, 33667, 43667, 45667 }

-- The last port that answered (or the panel's choice) first, then the list.
function Ports.order(preferred: number?): { number }
	local ordered: { number } = {}
	if preferred ~= nil then
		table.insert(ordered, preferred)
	end
	for _, port in Ports.CANDIDATES do
		if port ~= preferred then
			table.insert(ordered, port)
		end
	end
	return ordered
end

return Ports
