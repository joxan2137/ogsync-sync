--!strict
-- Dot-path grammar: game.ServerScriptService.Main, game.Workspace["My.Part"],
-- pseudo-roots @game and @selection. docs/TOOLS.md is the authority.

local Path = {}

local SERVICE_NAMES = {
	"Workspace", "Players", "Lighting", "ReplicatedFirst", "ReplicatedStorage",
	"ServerScriptService", "ServerStorage", "StarterGui", "StarterPack",
	"StarterPlayer", "SoundService", "Chat", "TextChatService", "Teams",
	"LocalizationService", "MaterialService", "TestService", "CollectionService",
	"HttpService", "InsertService", "TweenService", "PhysicsService",
	"RunService", "ScriptContext", "ScriptEditorService", "Selection",
	"CoreGui", "StudioService", "ChangeHistoryService", "AssetService",
	"MarketplaceService", "DataStoreService", "MemStorageService",
	"VoiceChatService", "AvatarEditorService", "GuiService", "UserInputService",
	"ContextActionService", "Debris", "PathfindingService", "ProximityPromptService",
	"TerrainDetail", "TextService", "Terrain",
}

local services: {[string]: boolean} = {}
for _, name in SERVICE_NAMES do
	services[name] = true
end
Path.SERVICES = services :: {[string]: boolean}

local function isIdentifier(name: string): boolean
	return string.match(name, "^[%a_][%w_]*$") ~= nil
end

local function quote(name: string): string
	local escaped = string.gsub(name, "[\\\"]", "\\%0")
	return "\"" .. escaped .. "\""
end

local function tokenize(path: string): ({string}, string?)
	local segments: {string} = {}
	local i = 1
	local length = #path
	local afterSegment = false
	while i <= length do
		local char = string.sub(path, i, i)
		if char == "." then
			if not afterSegment then
				return {}, string.format("empty path segment at %d in '%s'", i, path)
			end
			afterSegment = false
			i += 1
		elseif char == "[" then
			local opener = string.sub(path, i + 1, i + 1)
			if opener == "\"" or opener == "'" then
				local chars: {string} = {}
				local j = i + 2
				local closed = false
				while j <= length do
					local inner = string.sub(path, j, j)
					if inner == "\\" then
						-- quote() escapes exactly `"` and `\`; every other
						-- backslash is a literal one, not an escape sequence.
						local escaped = string.sub(path, j + 1, j + 1)
						if escaped == "\"" or escaped == "\\" then
							table.insert(chars, escaped)
							j += 2
						else
							table.insert(chars, "\\")
							j += 1
						end
					elseif inner == opener then
						closed = true
						break
					else
						table.insert(chars, inner)
						j += 1
					end
				end
				if not closed or string.sub(path, j + 1, j + 1) ~= "]" then
					return {}, string.format("unterminated bracket in '%s'", path)
				end
				table.insert(segments, table.concat(chars))
				i = j + 2
			else
				local close = string.find(path, "]", i + 1, true)
				if not close then
					return {}, string.format("unterminated bracket in '%s'", path)
				end
				table.insert(segments, string.sub(path, i + 1, close - 1))
				i = close + 1
			end
			afterSegment = true
		else
			local j = i
			while j <= length do
				local inner = string.sub(path, j, j)
				if inner == "." or inner == "[" then
					break
				end
				j += 1
			end
			local segment = string.sub(path, i, j - 1)
			if segment == "" then
				return {}, string.format("empty path segment at %d in '%s'", i, path)
			end
			table.insert(segments, segment)
			i = j
			afterSegment = true
		end
	end
	if #segments == 0 then
		return {}, "empty path"
	end
	return segments, nil
end

local function rootsOf(segment: string): ({Instance}, string?)
	if segment == "@selection" then
		-- Selection is Studio-only: fetched here so play-mode requires still work.
		local okService, selected = pcall(function(): {Instance}
			return game:GetService("Selection"):Get()
		end)
		if not okService then
			return {}, "selection unavailable in this context"
		end
		if #selected == 0 then
			return {}, "selection is empty"
		end
		return selected, nil
	end
	if segment == "@game" or segment == "game" then
		return { game }, nil
	end
	local existing = game:FindFirstChild(segment)
	if existing then
		return { existing }, nil
	end
	local ok, service = pcall(function(): Instance
		return game:GetService(segment :: any)
	end)
	if ok then
		return { service }, nil
	end
	return {}, string.format("unknown path root '%s'", segment)
end

local function childOf(parent: Instance, name: string): Instance?
	local found = parent:FindFirstChild(name)
	if found then
		return found
	end
	if parent == game then
		local ok, service = pcall(function(): Instance
			return game:GetService(name :: any)
		end)
		if ok then
			return service
		end
	end
	return nil
end

local function join(root: string, names: {string}): string
	local out = root
	for _, name in names do
		if isIdentifier(name) then
			out ..= "." .. name
		else
			out ..= "[" .. quote(name) .. "]"
		end
	end
	return out
end

-- Parent path + leaf name, needed to create instances at a path that does not
-- exist yet.
function Path.split(path: string): (string?, string?, string?)
	local trimmed = string.match(path, "^%s*(.-)%s*$") or path
	local segments, tokenErr = tokenize(trimmed)
	if tokenErr then
		return nil, nil, tokenErr
	end
	if #segments < 2 then
		return nil, nil, string.format("path '%s' has no parent", trimmed)
	end
	local middle: {string} = {}
	for index = 2, #segments - 1 do
		table.insert(middle, segments[index])
	end
	return join(segments[1], middle), segments[#segments], nil
end

function Path.resolveMulti(path: string): ({Instance}, string?)
	local trimmed = string.match(path, "^%s*(.-)%s*$") or path
	local segments, tokenErr = tokenize(trimmed)
	if tokenErr then
		return {}, tokenErr
	end
	local bases, rootErr = rootsOf(segments[1])
	if rootErr then
		return {}, rootErr
	end
	local resolved: {Instance} = {}
	for _, base in bases do
		local current: Instance? = base
		for index = 2, #segments do
			if current == nil then
				break
			end
			current = childOf(current :: Instance, segments[index])
		end
		if current then
			table.insert(resolved, current)
		end
	end
	if #resolved == 0 then
		return {}, string.format("no instance at '%s'", trimmed)
	end
	return resolved, nil
end

function Path.resolve(path: string): (Instance?, string?)
	local resolved, err = Path.resolveMulti(path)
	if err then
		return nil, err
	end
	return resolved[1], nil
end

local function hasNamesake(inst: Instance): boolean
	local parent = inst.Parent
	if parent == nil then
		return false
	end
	local seen = false
	for _, child in parent:GetChildren() do
		if child.Name == inst.Name then
			if seen then
				return true
			end
			seen = true
		end
	end
	return false
end

function Path.of(inst: Instance): string
	if inst == game then
		return "game"
	end
	local names: {string} = {}
	local current: Instance? = inst
	while current ~= nil and current ~= game do
		table.insert(names, 1, current.Name)
		current = current.Parent
	end
	local out = if current == game then "game" else ""
	for _, name in names do
		if isIdentifier(name) then
			out = if out == "" then name else out .. "." .. name
		else
			out ..= "[" .. quote(name) .. "]"
		end
	end
	return out
end

-- Path.of plus "a segment of this path names more than one sibling". Such a path
-- addresses two instances at once, so callers that map paths to files (sync) must
-- leave it alone rather than write one twin over the other.
function Path.ofChecked(inst: Instance): (string, boolean)
	local ambiguous = false
	local current: Instance? = inst
	while current ~= nil and current ~= game do
		if hasNamesake(current) then
			ambiguous = true
			break
		end
		current = current.Parent
	end
	return Path.of(inst), ambiguous
end

return Path
