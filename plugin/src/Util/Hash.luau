--!strict
-- Dual FNV-1a 32-bit over raw string bytes, hex-concatenated (16 chars).
-- MUST stay bit-identical to contentHash() in server/src/proto/types.ts:
-- echo suppression and conflict detection compare these across the wire.

local PRIME1 = 0x01000193
local PRIME2 = 0x01000197

-- Exact 32-bit multiply: split into 16-bit halves so no intermediate
-- exceeds 2^53 (Luau numbers are doubles).
local function mul32(a: number, b: number): number
	local alo = bit32.band(a, 0xFFFF)
	local ahi = bit32.rshift(a, 16)
	local blo = bit32.band(b, 0xFFFF)
	local bhi = bit32.rshift(b, 16)
	local lo = alo * blo
	local mid = bit32.band(alo * bhi + ahi * blo, 0xFFFF)
	return bit32.band(lo + mid * 0x10000, 0xFFFFFFFF)
end

local function toHex8(n: number): string
	return string.format("%08x", n)
end

local Hash = {}

function Hash.content(s: string): string
	local h1 = 0x811c9dc5
	local h2 = 0x01234567
	for i = 1, #s do
		local b = string.byte(s, i)
		h1 = mul32(bit32.bxor(h1, b), PRIME1)
		h2 = mul32(bit32.bxor(h2, b), PRIME2)
	end
	return toHex8(h1) .. toHex8(h2)
end

return Hash
