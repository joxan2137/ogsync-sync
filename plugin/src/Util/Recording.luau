--!strict
-- One tool call = one undo step: every place write runs inside a
-- ChangeHistoryService recording. A write that throws cancels its recording, so
-- a half-applied batch is rolled back instead of left behind for Undo to miss.
--
-- Recorded writes run one at a time: Cancel rolls back everything changed since
-- TryBeginRecording, so a second write landing while the first one yields would
-- be rolled back with it.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Recording = {}

local busy = false
local waiting: { thread } = {}

local function acquire()
	if busy then
		table.insert(waiting, coroutine.running())
		coroutine.yield()
		return
	end
	busy = true
end

-- Ownership passes straight to the next waiter, so nobody can slip in between.
local function release()
	local nextWriter = table.remove(waiting, 1)
	if nextWriter ~= nil then
		task.defer(nextWriter)
	else
		busy = false
	end
end

function Recording.run<T>(name: string, fn: () -> T): T
	acquire()
	local began, identifier = pcall(function(): string?
		return ChangeHistoryService:TryBeginRecording(name)
	end)
	-- nil while another plugin's recording is open, or outside edit mode: the
	-- write still happens, it just cannot be grouped into its own undo step.
	local recording = if began and type(identifier) == "string" then identifier else nil
	local ok, result = pcall(fn)
	if recording ~= nil then
		local operation = if ok then Enum.FinishRecordingOperation.Commit else Enum.FinishRecordingOperation.Cancel
		pcall(function()
			ChangeHistoryService:FinishRecording(recording, operation)
		end)
	end
	release()
	if not ok then
		error(result, 0)
	end
	return result
end

return Recording
