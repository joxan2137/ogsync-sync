--!strict
-- script.read/edit/grep: source access through ScriptEditorService so open editors stay in sync.

local ScriptEditorService = game:GetService("ScriptEditorService")

local Src = script.Parent.Parent :: any
local Path = require(Src.Util.Path)
local Hash = require(Src.Util.Hash)
local Output = require(Src.Util.Output)

type Register = (string, (any) -> any) -> ()

type Matcher = { plain: boolean, patterns: { string } }

local READ_LIMIT_DEFAULT = 200
local GREP_LIMIT_DEFAULT = 50
local CONTEXT_LINES = 3
local SCRIPTS_PER_YIELD = 500

local function splitLines(source: string): { string }
	local lines = string.split(source, "\n")
	for index, line in lines do
		if string.sub(line, -1) == "\r" then
			lines[index] = string.sub(line, 1, -2)
		end
	end
	return lines
end

local function readSource(inst: Instance): string
	local docOk, document = pcall(function()
		return ScriptEditorService:FindScriptDocument(inst)
	end)
	if docOk and document then
		local textOk, text = pcall(function()
			return document:GetText()
		end)
		if textOk and type(text) == "string" then
			return text
		end
	end
	local ok, source = pcall(function()
		return (inst :: any).Source
	end)
	if not ok or type(source) ~= "string" then
		error("cannot read source of " .. Path.of(inst) .. ": " .. tostring(source))
	end
	return source
end

local function writeSource(inst: Instance, newSource: string)
	local ok, err = pcall(function()
		ScriptEditorService:UpdateSourceAsync(inst, function()
			return newSource
		end)
	end)
	if not ok then
		error("cannot write source of " .. Path.of(inst) .. ": " .. tostring(err))
	end
end

local function requireScript(path: any): Instance
	if type(path) ~= "string" then
		error("path must be a string")
	end
	local inst, err = Path.resolve(path)
	if not inst then
		error(err or ("no instance at " .. path))
	end
	if not inst:IsA("LuaSourceContainer") then
		error(path .. " is a " .. inst.ClassName .. ", not a script")
	end
	return inst
end

local function escapePattern(literal: string): string
	local escaped = string.gsub(literal, "([%^%$%(%)%%%.%[%]%*%+%-%?])", "%%%1")
	return escaped
end

local function escapeReplacement(replacement: string): string
	local escaped = string.gsub(replacement, "%%", "%%%%")
	return escaped
end

local function lineOfOffset(source: string, offset: number): number
	local prefix = string.sub(source, 1, math.max(offset - 1, 0))
	local _, newlines = string.gsub(prefix, "\n", "")
	return newlines + 1
end

local function contextAround(lines: { string }, center: number): { any }
	local context = {}
	for index = math.max(center - CONTEXT_LINES, 1), math.min(center + CONTEXT_LINES, #lines) do
		table.insert(context, { n = index, t = lines[index] })
	end
	return context
end

-- Regex subset → Lua pattern. Supported: literals, `.`, `\w \d \s \W \D \S`,
-- `* + ? *?`, `^ $`, `[...]` sets, top-level `|`. Unsupported (groups, `{n,m}`,
-- backreferences, lookaround) fall back to a plain literal search.
local CLASS_MAP: { [string]: string } = {
	w = "[%w_]",
	W = "[^%w_]",
	d = "%d",
	D = "%D",
	s = "%s",
	S = "%S",
}

local SET_CLASS_MAP: { [string]: string } = {
	w = "%w_",
	W = "%W",
	d = "%d",
	D = "%D",
	s = "%s",
	S = "%S",
}

local function convertSet(regex: string, start: number): (string?, number)
	local out = "["
	local index = start + 1
	if string.sub(regex, index, index) == "^" then
		out ..= "^"
		index += 1
	end
	if string.sub(regex, index, index) == "]" then
		out ..= "%]"
		index += 1
	end
	while index <= #regex do
		local ch = string.sub(regex, index, index)
		if ch == "]" then
			return out .. "]", index + 1
		elseif ch == "\\" then
			local next = string.sub(regex, index + 1, index + 1)
			local mapped = SET_CLASS_MAP[next]
			if mapped then
				out ..= mapped
			elseif string.find(next, "^%w$") then
				out ..= next
			else
				out ..= "%" .. next
			end
			index += 2
		elseif ch == "%" then
			out ..= "%%"
			index += 1
		elseif ch == "^" then
			out ..= "%^"
			index += 1
		else
			out ..= ch
			index += 1
		end
	end
	return nil, index
end

local function convertAlternative(regex: string): string?
	local out = ""
	local index = 1
	while index <= #regex do
		local ch = string.sub(regex, index, index)
		if ch == "\\" then
			local next = string.sub(regex, index + 1, index + 1)
			local mapped = CLASS_MAP[next]
			if mapped then
				out ..= mapped
			elseif next == "" then
				return nil
			elseif string.find(next, "^%w$") then
				return nil
			else
				out ..= escapePattern(next)
			end
			index += 2
		elseif ch == "[" then
			local set, nextIndex = convertSet(regex, index)
			if not set then
				return nil
			end
			out ..= set
			index = nextIndex
		elseif ch == "*" or ch == "+" then
			if string.sub(regex, index + 1, index + 1) == "?" then
				if ch == "+" then
					return nil
				end
				out ..= "-"
				index += 2
			else
				out ..= ch
				index += 1
			end
		elseif ch == "?" then
			out ..= "?"
			index += 1
		elseif ch == "." then
			out ..= "."
			index += 1
		elseif ch == "^" then
			if index ~= 1 then
				return nil
			end
			out ..= "^"
			index += 1
		elseif ch == "$" then
			if index ~= #regex then
				return nil
			end
			out ..= "$"
			index += 1
		elseif ch == "(" or ch == ")" or ch == "{" or ch == "}" or ch == "|" then
			return nil
		elseif ch == "%" then
			out ..= "%%"
			index += 1
		else
			out ..= escapePattern(ch)
			index += 1
		end
	end
	return out
end

local function splitAlternation(regex: string): { string }?
	local parts = {}
	local current = ""
	local inSet = false
	local index = 1
	while index <= #regex do
		local ch = string.sub(regex, index, index)
		if ch == "\\" then
			current ..= ch .. string.sub(regex, index + 1, index + 1)
			index += 2
			continue
		elseif ch == "(" then
			return nil
		elseif ch == "[" then
			inSet = true
		elseif ch == "]" then
			inSet = false
		elseif ch == "|" and not inSet then
			table.insert(parts, current)
			current = ""
			index += 1
			continue
		end
		current ..= ch
		index += 1
	end
	table.insert(parts, current)
	return parts
end

local function buildMatcher(pattern: string): Matcher
	local alternatives = splitAlternation(pattern)
	if not alternatives then
		return { plain = true, patterns = { pattern } }
	end
	local converted = {}
	for _, alternative in alternatives do
		local luaPattern = convertAlternative(alternative)
		if not luaPattern then
			return { plain = true, patterns = { pattern } }
		end
		table.insert(converted, luaPattern)
	end
	return { plain = false, patterns = converted }
end

local function matchLine(line: string, matcher: Matcher): number?
	for _, pattern in matcher.patterns do
		if matcher.plain then
			local start = string.find(line, pattern, 1, true)
			if start then
				return start
			end
		else
			local ok, start = pcall(string.find, line, pattern)
			if ok and start then
				return start :: number
			end
		end
	end
	return nil
end

local function replaceInLine(line: string, matcher: Matcher, replacement: string): (string, number)
	local result = line
	local total = 0
	for _, pattern in matcher.patterns do
		local search = if matcher.plain then escapePattern(pattern) else pattern
		local ok, replaced, count = pcall(string.gsub, result, search, escapeReplacement(replacement))
		if ok and type(replaced) == "string" then
			result = replaced
			total += count :: number
		end
	end
	return result, total
end

local function globMatches(inst: Instance, glob: string): boolean
	local pattern = "^"
	for index = 1, #glob do
		local ch = string.sub(glob, index, index)
		if ch == "*" then
			pattern ..= ".*"
		elseif ch == "?" then
			pattern ..= "."
		else
			pattern ..= escapePattern(ch)
		end
	end
	pattern ..= "$"
	if string.find(inst.Name, pattern) then
		return true
	end
	return string.find(Path.of(inst), pattern) ~= nil
end

local function collectScripts(root: Instance, glob: any): { Instance }
	local scripts = {}
	if root:IsA("LuaSourceContainer") then
		table.insert(scripts, root)
	end
	for _, descendant in root:GetDescendants() do
		if descendant:IsA("LuaSourceContainer") then
			if type(glob) == "string" and not globMatches(descendant, glob) then
				continue
			end
			table.insert(scripts, descendant)
		end
	end
	return scripts
end

return function(register: Register)
	register("script.read", function(args: any): any
		local inst = requireScript(args.path)
		local source = readSource(inst)
		local lines = splitLines(source)
		local offset = math.max(tonumber(args.offset) or 1, 1)
		local limit = math.max(tonumber(args.limit) or READ_LIMIT_DEFAULT, 1)
		local slice = {}
		for index = offset, math.min(offset + limit - 1, #lines) do
			table.insert(slice, lines[index])
		end
		local capped, truncated = Output.capList(slice)
		return {
			path = Path.of(inst),
			class = inst.ClassName,
			offset = offset,
			lines = capped,
			total = #lines,
			hash = Hash.content(source),
			truncated = truncated,
		}
	end)

	register("script.edit", function(args: any): any
		local inst: Instance? = nil
		local created = false
		if type(args.path) ~= "string" then
			error("path must be a string")
		end

		local resolved = Path.resolve(args.path)
		if resolved then
			if not resolved:IsA("LuaSourceContainer") then
				error(args.path .. " is a " .. resolved.ClassName .. ", not a script")
			end
			inst = resolved
		elseif type(args.source) == "string" then
			local parentPath, name, splitErr = Path.split(args.path)
			if not parentPath or not name then
				error(splitErr or ("cannot derive a parent from " .. args.path))
			end
			local parent, parentErr = Path.resolve(parentPath)
			if not parent then
				error(parentErr or ("no instance at " .. parentPath))
			end
			local class = if type(args.class) == "string" then args.class else "ModuleScript"
			local ok, newScript = pcall(Instance.new, class)
			if not ok then
				error("cannot create " .. class .. ": " .. tostring(newScript))
			end
			newScript.Name = name
			newScript.Parent = parent
			inst = newScript
			created = true
		else
			error("no script at " .. args.path .. " (pass `source` to create one)")
		end

		local target = inst :: Instance
		local source = if created then "" else readSource(target)
		local newSource: string
		local center = 1
		local replacedCount: number? = nil

		if type(args.old) == "string" then
			if type(args.new) ~= "string" then
				error("old/new edit requires `new`")
			end
			local pattern = escapePattern(args.old)
			local first = string.find(source, pattern)
			if not first then
				error("`old` text not found in " .. Path.of(target))
			end
			local count: number
			if args.all == true then
				newSource, count = string.gsub(source, pattern, escapeReplacement(args.new))
			else
				local _, occurrences = string.gsub(source, pattern, "")
				if occurrences > 1 then
					error("`old` matches " .. occurrences .. " times — pass all=true or extend the snippet")
				end
				newSource, count = string.gsub(source, pattern, escapeReplacement(args.new), 1)
			end
			if count == 0 then
				error("`old` text not found in " .. Path.of(target))
			end
			replacedCount = count
			center = lineOfOffset(source, first)
		elseif type(args.lines) == "table" then
			if type(args.new) ~= "string" then
				error("lines edit requires `new` (\"\" deletes)")
			end
			local lines = splitLines(source)
			local first = math.max(tonumber(args.lines.start) or 1, 1)
			local last = math.min(tonumber(args.lines["end"]) or first, #lines)
			if first > #lines + 1 then
				error("line " .. first .. " is past the end of " .. Path.of(target) .. " (" .. #lines .. " lines)")
			end
			local out = {}
			for index = 1, first - 1 do
				table.insert(out, lines[index])
			end
			if args.new ~= "" then
				for _, line in splitLines(args.new) do
					table.insert(out, line)
				end
			end
			for index = last + 1, #lines do
				table.insert(out, lines[index])
			end
			newSource = table.concat(out, "\n")
			center = first
		elseif args.insert_after ~= nil then
			if type(args.new) ~= "string" then
				error("insert_after edit requires `new`")
			end
			local lines = splitLines(source)
			local after = math.clamp(tonumber(args.insert_after) or 0, 0, #lines)
			local out = {}
			for index = 1, after do
				table.insert(out, lines[index])
			end
			for _, line in splitLines(args.new) do
				table.insert(out, line)
			end
			for index = after + 1, #lines do
				table.insert(out, lines[index])
			end
			newSource = table.concat(out, "\n")
			center = after + 1
		elseif type(args.source) == "string" then
			newSource = args.source
			center = 1
		else
			error("edit needs exactly one of old/new, lines, insert_after or source")
		end

		writeSource(target, newSource)
		local newLines = splitLines(newSource)
		return {
			ok = true,
			path = Path.of(target),
			created = created,
			total = #newLines,
			hash = Hash.content(newSource),
			replaced = replacedCount,
			context = contextAround(newLines, center),
		}
	end)

	register("script.grep", function(args: any): any
		if type(args.pattern) ~= "string" then
			error("grep requires a pattern")
		end
		local root, rootErr = Path.resolve(args.root or "@game")
		if not root then
			error(rootErr or "root not found")
		end
		local mode = args.mode or "content"
		local replacement = args.replace
		if replacement ~= nil and mode ~= "content" then
			error("replace requires mode=content")
		end
		local limit = math.max(tonumber(args.limit) or GREP_LIMIT_DEFAULT, 1)
		local contextLines = math.max(tonumber(args.context) or 0, 0)
		local matcher = buildMatcher(args.pattern)

		local scripts = collectScripts(root, args.glob)
		local matches = {}
		local files = {}
		local counts = {}
		local changes = {}
		local totalMatches = 0
		local truncated = false

		for index, inst in scripts do
			if index % SCRIPTS_PER_YIELD == 0 then
				task.wait()
			end
			local sourceOk, source = pcall(readSource, inst)
			if not sourceOk then
				continue
			end
			local lines = splitLines(source)
			local path = Path.of(inst)
			local fileMatches = 0
			local replaced = 0

			for lineNumber, line in lines do
				if not matchLine(line, matcher) then
					continue
				end
				fileMatches += 1
				totalMatches += 1
				if replacement ~= nil then
					local newLine, count = replaceInLine(line, matcher, tostring(replacement))
					lines[lineNumber] = newLine
					replaced += count
				elseif mode == "content" and #matches < limit then
					local entry: any = { path = path, line = lineNumber, text = line }
					if contextLines > 0 then
						local before = {}
						local after = {}
						for i = math.max(lineNumber - contextLines, 1), lineNumber - 1 do
							table.insert(before, { n = i, t = lines[i] })
						end
						for i = lineNumber + 1, math.min(lineNumber + contextLines, #lines) do
							table.insert(after, { n = i, t = lines[i] })
						end
						entry.before = before
						entry.after = after
					end
					table.insert(matches, entry)
				end
			end

			if fileMatches > 0 then
				table.insert(files, path)
				table.insert(counts, { path = path, count = fileMatches })
				if replaced > 0 then
					writeSource(inst, table.concat(lines, "\n"))
					table.insert(changes, { path = path, count = replaced })
				end
			end
			if mode == "content" and replacement == nil and #matches >= limit and totalMatches > limit then
				truncated = true
			end
		end

		local result: any = {
			mode = mode,
			total = totalMatches,
			scripts = #scripts,
			plain = matcher.plain,
		}
		if replacement ~= nil then
			result.changed = changes
		elseif mode == "files" then
			local list, capped = Output.capList(files)
			result.files = list
			result.truncated = truncated or capped
		elseif mode == "count" then
			local list, capped = Output.capList(counts)
			result.counts = list
			result.truncated = truncated or capped
		else
			local list, capped = Output.capList(matches)
			result.matches = list
			result.truncated = truncated or capped
		end
		return result
	end)
end
