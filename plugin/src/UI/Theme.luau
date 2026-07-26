--!strict
-- Studio theme colors for the connection panel. Every lookup is pcall'd against
-- a fallback so an unknown StudioStyleGuideColor can never break the panel.

local Theme = {}

export type Palette = {
	background: Color3,
	panel: Color3,
	border: Color3,
	text: Color3,
	subText: Color3,
	button: Color3,
	buttonText: Color3,
	inputBackground: Color3,
	ok: Color3,
	warn: Color3,
	idle: Color3,
	bad: Color3,
}

local function styleColor(name: string): any
	local ok, value = pcall(function(): any
		return (Enum.StudioStyleGuideColor :: any)[name]
	end)
	return if ok then value else nil
end

type Spec = { style: any, fallback: Color3 }

local SPEC: {[string]: Spec} = {
	background = { style = styleColor("MainBackground"), fallback = Color3.fromRGB(46, 46, 46) },
	panel = { style = styleColor("Tab"), fallback = Color3.fromRGB(56, 56, 56) },
	border = { style = styleColor("Border"), fallback = Color3.fromRGB(34, 34, 34) },
	text = { style = styleColor("MainText"), fallback = Color3.fromRGB(234, 234, 234) },
	subText = { style = styleColor("DimmedText"), fallback = Color3.fromRGB(150, 150, 150) },
	button = { style = styleColor("Button"), fallback = Color3.fromRGB(66, 66, 66) },
	buttonText = { style = styleColor("ButtonText"), fallback = Color3.fromRGB(234, 234, 234) },
	inputBackground = { style = styleColor("InputFieldBackground"), fallback = Color3.fromRGB(37, 37, 37) },
	-- Status dots: the style guide has no semantic "healthy" color, so the
	-- indicator hues are fixed and only the neutral one follows the theme.
	ok = { style = nil, fallback = Color3.fromRGB(86, 184, 118) },
	warn = { style = styleColor("WarningText"), fallback = Color3.fromRGB(226, 170, 66) },
	idle = { style = styleColor("DimmedText"), fallback = Color3.fromRGB(130, 130, 130) },
	bad = { style = styleColor("ErrorText"), fallback = Color3.fromRGB(216, 84, 84) },
}

local function studio(): any
	local ok, value = pcall(function(): any
		return settings().Studio
	end)
	return if ok then value else nil
end

function Theme.palette(): Palette
	local studioTheme: any = nil
	local current = studio()
	if current ~= nil then
		local ok, value = pcall(function(): any
			return current.Theme
		end)
		if ok then
			studioTheme = value
		end
	end

	local function color(key: string): Color3
		local spec = SPEC[key]
		if studioTheme ~= nil and spec.style ~= nil then
			local ok, value = pcall(function(): Color3
				return studioTheme:GetColor(spec.style)
			end)
			if ok then
				return value
			end
		end
		return spec.fallback
	end

	return {
		background = color("background"),
		panel = color("panel"),
		border = color("border"),
		text = color("text"),
		subText = color("subText"),
		button = color("button"),
		buttonText = color("buttonText"),
		inputBackground = color("inputBackground"),
		ok = color("ok"),
		warn = color("warn"),
		idle = color("idle"),
		bad = color("bad"),
	}
end

function Theme.onChanged(callback: () -> ()): () -> ()
	local current = studio()
	if current == nil then
		return function() end
	end
	local ok, connection = pcall(function(): RBXScriptConnection
		return current.ThemeChanged:Connect(callback)
	end)
	if not ok then
		return function() end
	end
	return function()
		connection:Disconnect()
	end
end

return Theme
