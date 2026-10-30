--!strict
-- Eval job registry. Every job carries a generation number. A job that is
-- cancelled, or superseded by a newer job started under the same key, stops
-- being current: timers it armed through `ogsync.delay` and a late finish from
-- its thread become no-ops instead of clobbering the job that replaced it.

local MAX_FINISHED = 32
local MAX_OUTPUT_BYTES = 100 * 1024

export type Entry = { level: string, text: string }

export type Job = {
	id: string,
	gen: number,
	key: string?,
	vm: string,
	context: string,
	status: string,
	cancelled: boolean,
	startedAt: number,
	finishedAt: number?,
	output: { Entry },
	bytes: number,
	dropped: number,
	returns: { any }?,
	err: string?,
	onCancel: (() -> ())?,
}

export type Spec = { key: string?, vm: string, context: string }

local Jobs = {}
Jobs.__index = Jobs

export type Registry = typeof(setmetatable(
	{} :: { nonce: string, generation: number, jobs: { [string]: Job }, current: { [string]: Job } },
	Jobs
))

function Jobs.new(nonce: string): Registry
	return setmetatable({ nonce = nonce, generation = 0, jobs = {}, current = {} }, Jobs)
end

function Jobs.start(self: Registry, spec: Spec): Job
	self.generation += 1
	local job: Job = {
		id = tostring(self.generation),
		gen = self.generation,
		key = spec.key,
		vm = spec.vm,
		context = spec.context,
		status = "running",
		cancelled = false,
		startedAt = os.clock(),
		output = {},
		bytes = 0,
		dropped = 0,
	}
	self.jobs[job.id] = job
	local key = spec.key
	if key ~= nil then
		local previous = self.current[key]
		self.current[key] = job
		if previous ~= nil then
			self:cancel(previous, string.format("superseded by job %s (key %s)", job.id, key))
		end
	end
	return job
end

function Jobs.isCurrent(self: Registry, job: Job): boolean
	if job.cancelled then
		return false
	end
	local key = job.key
	return key == nil or self.current[key] == job
end

-- Wraps a callback so it only runs while `job` is still current.
function Jobs.guard(self: Registry, job: Job, fn: (...any) -> ...any): (...any) -> ()
	return function(...)
		if self:isCurrent(job) then
			fn(...)
		end
	end
end

function Jobs.emit(_self: Registry, job: Job, level: string, text: string)
	if job.cancelled then
		return
	end
	if job.bytes + #text > MAX_OUTPUT_BYTES then
		job.dropped += 1
		return
	end
	job.bytes += #text
	table.insert(job.output, { level = level, text = text })
end

local function prune(self: Registry)
	local finished = {}
	for _, job in self.jobs do
		if job.status ~= "running" then
			table.insert(finished, job)
		end
	end
	if #finished <= MAX_FINISHED then
		return
	end
	table.sort(finished, function(a: Job, b: Job): boolean
		return a.gen < b.gen
	end)
	for index = 1, #finished - MAX_FINISHED do
		self.jobs[finished[index].id] = nil
	end
end

-- false when the job already settled (cancelled first, or finished twice).
function Jobs.finish(self: Registry, job: Job, ok: boolean, payload: any): boolean
	if job.status ~= "running" then
		return false
	end
	job.status = if ok then "done" else "error"
	job.finishedAt = os.clock()
	if ok then
		job.returns = payload
	else
		job.err = tostring(payload)
	end
	prune(self)
	return true
end

function Jobs.cancel(self: Registry, job: Job, reason: string)
	if job.cancelled then
		return
	end
	job.cancelled = true
	if job.status == "running" then
		job.status = "cancelled"
		job.err = reason
		job.finishedAt = os.clock()
	end
	local onCancel = job.onCancel
	job.onCancel = nil
	if onCancel ~= nil then
		pcall(onCancel)
	end
	prune(self)
end

function Jobs.get(self: Registry, id: string): Job?
	return self.jobs[id]
end

function Jobs.take(self: Registry, id: string): Job?
	local job = self.jobs[id]
	self.jobs[id] = nil
	return job
end

function Jobs.snapshot(self: Registry, job: Job): any
	return {
		id = job.id,
		gen = job.gen,
		nonce = self.nonce,
		key = job.key,
		vm = job.vm,
		context = job.context,
		status = job.status,
		elapsed = (job.finishedAt or os.clock()) - job.startedAt,
		output = job.output,
		dropped = job.dropped,
		returns = job.returns,
		err = job.err,
	}
end

function Jobs.list(self: Registry): { any }
	local out = {}
	for _, job in self.jobs do
		table.insert(out, {
			id = job.id,
			gen = job.gen,
			key = job.key,
			vm = job.vm,
			context = job.context,
			status = job.status,
			elapsed = (job.finishedAt or os.clock()) - job.startedAt,
		})
	end
	table.sort(out, function(a: any, b: any): boolean
		return a.gen < b.gen
	end)
	return out
end

return Jobs
