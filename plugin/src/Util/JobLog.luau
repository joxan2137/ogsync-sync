--!strict
-- Job ids this plugin load has seen. After a reconnect the daemon redelivers
-- every job it has no answer for; a job already running or finished is not
-- started again (its result is still in, or already through, the push queue),
-- so redelivery never runs an op twice.

export type JobLog = {
	capacity: number,
	done: { [string]: boolean },
	order: { string },
}

local JobLog = {}

function JobLog.new(capacity: number?): JobLog
	return { capacity = capacity or 512, done = {}, order = {} }
end

-- "new" when the job should run now; otherwise "running" or "done".
function JobLog.begin(log: JobLog, id: string): string
	local finished = log.done[id]
	if finished ~= nil then
		return if finished then "done" else "running"
	end
	log.done[id] = false
	table.insert(log.order, id)
	while #log.order > log.capacity do
		local evicted = table.remove(log.order, 1)
		if evicted ~= nil then
			log.done[evicted] = nil
		end
	end
	return "new"
end

function JobLog.finish(log: JobLog, id: string)
	if log.done[id] ~= nil then
		log.done[id] = true
	end
end

return JobLog
