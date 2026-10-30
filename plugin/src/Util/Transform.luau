--!strict
-- Bulk move/rotate planning for inst.transform. Every target pivot is computed
-- from the ORIGINAL pivots before anything moves: PivotTo on one member of a
-- welded assembly drags its partners, so moves applied one by one would compound
-- on whatever was already dragged. Applying precomputed absolute pivots instead
-- lands every listed instance exactly once, in any order.

export type Spec = {
	move: Vector3?,
	rotation: CFrame?,
	origin: string | Vector3,
	to: CFrame?,
	toPosition: Vector3?,
}

export type Member = { inst: Instance, from: CFrame }

export type Group = { spec: Spec, members: { Member } }

export type Step = { inst: Instance, from: CFrame, to: CFrame }

export type Skip = { inst: Instance, ancestor: Instance }

local Transform = {}

local function vector(value: any, field: string): Vector3
	if type(value) ~= "table" or type(value[1]) ~= "number" or type(value[2]) ~= "number" or type(value[3]) ~= "number" then
		error(field .. " must be [x,y,z]", 0)
	end
	return Vector3.new(value[1], value[2], value[3])
end

function Transform.decodeSpec(raw: any): Spec
	local spec: Spec = { origin = "pivot" }
	if raw.to ~= nil then
		if raw.move ~= nil or raw.rotate ~= nil then
			error("`to` sets an absolute pivot and cannot be combined with move/rotate", 0)
		end
		if type(raw.to) == "table" and #raw.to == 12 then
			local c = raw.to
			for index = 1, 12 do
				if type(c[index]) ~= "number" then
					error("`to` must be [x,y,z] or 12 CFrame numbers", 0)
				end
			end
			spec.to = CFrame.new(c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12])
		else
			spec.toPosition = vector(raw.to, "to")
		end
		return spec
	end
	if raw.move == nil and raw.rotate == nil then
		error("each transform target needs move, rotate or to", 0)
	end
	if raw.move ~= nil then
		spec.move = vector(raw.move, "move")
	end
	if raw.rotate ~= nil then
		local degrees = vector(raw.rotate, "rotate")
		-- Y-X-Z, the order Studio's Orientation property uses.
		spec.rotation = CFrame.fromEulerAnglesYXZ(math.rad(degrees.X), math.rad(degrees.Y), math.rad(degrees.Z))
	end
	if raw.origin == nil or raw.origin == "pivot" or raw.origin == "center" then
		spec.origin = raw.origin or "pivot"
	else
		spec.origin = vector(raw.origin, "origin")
	end
	return spec
end

local function centroid(members: { Member }): Vector3
	local sum = Vector3.zero
	for _, member in members do
		sum += member.from.Position
	end
	return sum / math.max(#members, 1)
end

function Transform.target(from: CFrame, spec: Spec, center: Vector3): CFrame
	if spec.to ~= nil then
		return spec.to
	end
	if spec.toPosition ~= nil then
		return from.Rotation + spec.toPosition
	end
	local result = from
	local rotation = spec.rotation
	if rotation ~= nil then
		local pivot = if spec.origin == "pivot" then from.Position elseif spec.origin == "center" then center else spec.origin :: Vector3
		result = CFrame.new(pivot) * rotation * CFrame.new(-pivot) * from
	end
	if spec.move ~= nil then
		result = result + spec.move
	end
	return result
end

-- Only Model:PivotTo carries descendants; BasePart:PivotTo moves just that part
-- (and whatever is welded to it), so a part under a listed part still moves itself.
local function modelAncestorIn(inst: Instance, listed: { [Instance]: boolean }): Instance?
	local current = inst.Parent
	while current ~= nil do
		if listed[current] and current:IsA("Model") then
			return current
		end
		current = current.Parent
	end
	return nil
end

-- A listed instance under a listed Model rides along with that Model; giving it
-- a pivot of its own would fight the Model's rotation.
function Transform.plan(groups: { Group }): ({ Step }, { Skip })
	local listed: { [Instance]: boolean } = {}
	for _, group in groups do
		for _, member in group.members do
			listed[member.inst] = true
		end
	end

	local steps: { Step } = {}
	local skipped: { Skip } = {}
	local planned: { [Instance]: boolean } = {}
	for _, group in groups do
		local center = centroid(group.members)
		for _, member in group.members do
			if planned[member.inst] then
				continue
			end
			planned[member.inst] = true
			local ancestor = modelAncestorIn(member.inst, listed)
			if ancestor ~= nil then
				table.insert(skipped, { inst = member.inst, ancestor = ancestor })
				continue
			end
			table.insert(steps, { inst = member.inst, from = member.from, to = Transform.target(member.from, group.spec, center) })
		end
	end
	return steps, skipped
end

function Transform.describe(cframe: CFrame): { any }
	local rx, ry, rz = cframe:ToOrientation()
	local function round(n: number): number
		return math.floor(n * 1000 + 0.5) / 1000
	end
	local p = cframe.Position
	return {
		{ round(p.X), round(p.Y), round(p.Z) },
		{ round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) },
	}
end

return Transform
