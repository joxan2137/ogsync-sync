--!strict
-- One tool call = one undo step: every place write runs inside a
-- ChangeHistoryService recording. A write that throws cancels its recording, so
-- a half-applied batch is rolled back instead of left behind for Undo to miss.

local ChangeHistoryService = game:GetService("ChangeHistoryService")

local Recording = {}

function Recording.run<T>(name: string, fn: () -> T): T
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
	if not ok then
		error(result, 0)
	end
	return result
end

return Recording
