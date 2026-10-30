// One entry for every Claude Code hook the ogsync plugin registers.
//  - PreToolUse Edit/Write/MultiEdit: refuses writes under the project's guarded
//    paths while the bound place is in a playtest (sync would push them mid-test).
//  - Edit/Write/MultiEdit/Bash + Stop: Studio wins sync conflicts, so files this
//    session wrote are re-checked; when something else replaced them the agent is
//    told which file changed and where its own version was saved.
// Hook failures never block the agent: any error exits 0 with no output.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const OGSYNC_HOME = path.join(homedir(), ".ogsync");
const CLAUDE_HOME = path.join(OGSYNC_HOME, "claude");
const SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions");
const BACKUPS_DIR = path.join(CLAUDE_HOME, "backups");
const DEFAULT_PORT = 3667;
const STATE_TIMEOUT_MS = 800;
const MAX_TRACKED_BYTES = 2 * 1024 * 1024;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PLAYTEST_BUSY = new Set(["starting", "running", "stopping"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

function respond(payload) {
	if (!payload) process.exit(0);
	// exit only in the write callback: an immediate exit can drop stdout on Windows pipes
	process.stdout.write(JSON.stringify(payload) + "\n", () => process.exit(0));
}

function sha1(data) {
	return createHash("sha1").update(data).digest("hex");
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value));
	fs.renameSync(tmp, file);
}

// ---- daemon state ----

function daemonPort() {
	const info = readJson(path.join(OGSYNC_HOME, "daemon.json"), null);
	return (info && Number(info.port)) || DEFAULT_PORT;
}

function fetchState() {
	return new Promise((resolve) => {
		const req = http.get(
			{ host: "127.0.0.1", port: daemonPort(), path: "/state", timeout: STATE_TIMEOUT_MS, agent: false },
			(res) => {
				let body = "";
				res.on("data", (chunk) => (body += chunk));
				res.on("end", () => {
					try {
						resolve(JSON.parse(body));
					} catch {
						resolve(null);
					}
				});
			}
		);
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}

function findProjectConfig(file) {
	let dir = path.dirname(path.resolve(file));
	for (;;) {
		const candidate = path.join(dir, "ogsync.toml");
		if (fs.existsSync(candidate)) return { root: dir, ...parseConfig(fs.readFileSync(candidate, "utf8")) };
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// Reads only the two keys the hook needs; the daemon owns full TOML parsing.
function parseConfig(text) {
	let section = "";
	let targetPlace = null;
	let guardPaths = ["src"];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		const header = line.match(/^\[([^\]]+)\]$/);
		if (header) {
			section = header[1].trim();
			continue;
		}
		const pair = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
		if (!pair) continue;
		const [, key, value] = pair;
		if (section === "bind" && key === "target_place") targetPlace = value.replace(/^["']|["']$/g, "");
		if (section === "claude" && key === "guard_paths") {
			guardPaths = [...value.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
		}
	}
	return { targetPlace, guardPaths };
}

function matchPlace(state, target) {
	const places = (state && state.places) || [];
	if (!target) return places.length === 1 ? places[0] : null;
	const wanted = String(target).toLowerCase();
	return places.find((p) => [p.key, p.name, p.placeId].some((v) => v != null && String(v).toLowerCase() === wanted));
}

function isGuarded(file, config) {
	const rel = path.relative(config.root, path.resolve(file));
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;
	return config.guardPaths.some((guard) => rel === guard || rel.startsWith(guard + path.sep) || rel.startsWith(guard + "/"));
}

async function playtestDenial(file) {
	const config = findProjectConfig(file);
	if (!config || !isGuarded(file, config)) return null;
	const state = await fetchState();
	if (!state) return null;
	const place = matchPlace(state, config.targetPlace);
	const playtest = place && place.playtest;
	if (!playtest) return null;
	const where = `"${place.name || place.key}"`;
	const waitHint =
		"Wait for it with the ogsync `wait` tool ({\"for\":\"playtest\",\"state\":\"idle\"}) " +
		"or `ogsync call wait '{\"for\":\"playtest\",\"state\":\"idle\"}'` from a shell, then retry this edit.";
	if (PLAYTEST_BUSY.has(playtest.state)) {
		const owner = playtest.owner ? ` (owner: ${playtest.owner})` : " (started in Studio, not by an agent)";
		return `Studio place ${where} is in a playtest (${playtest.state})${owner}. Sync would push this file into the running test. ${waitHint}`;
	}
	if (playtest.state === "unknown") {
		return `OGSync lost the playtest heartbeat for place ${where}, so it cannot tell whether a test is running. Check that Studio is responsive (\`ogsync status\`). ${waitHint}`;
	}
	return null;
}

// ---- overwrite tracking ----

function sessionFile(sessionId) {
	return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function pendingDir(sessionId) {
	return path.join(SESSIONS_DIR, `${sessionId}.pending`);
}

function loadSession(sessionId) {
	return readJson(sessionFile(sessionId), { tracked: {}, notices: [] });
}

// Parallel tool calls run hooks concurrently, so a new write is queued as its own
// file and folded into the session record by the next hook that runs.
function queuePending(sessionId, file) {
	const dir = pendingDir(sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const key = path.resolve(file);
	fs.writeFileSync(path.join(dir, sha1(key)), key);
}

function snapshot(file) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > MAX_TRACKED_BYTES) return null;
		return { stat, content: fs.readFileSync(file) };
	} catch {
		return null;
	}
}

function backup(content, file) {
	const hash = sha1(content);
	const target = path.join(BACKUPS_DIR, `${hash}${path.extname(file)}`);
	if (!fs.existsSync(target)) {
		fs.mkdirSync(BACKUPS_DIR, { recursive: true });
		fs.writeFileSync(target, content);
	}
	return { hash, backup: target };
}

function record(session, file) {
	const snap = snapshot(file);
	if (!snap) {
		delete session.tracked[file];
		return;
	}
	session.tracked[file] = { ...backup(snap.content, file), mtimeMs: snap.stat.mtimeMs, size: snap.stat.size };
}

function flushPending(sessionId, session) {
	const dir = pendingDir(sessionId);
	let entries = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const marker = path.join(dir, entry);
		try {
			record(session, fs.readFileSync(marker, "utf8"));
			fs.unlinkSync(marker);
		} catch {}
	}
}

function otherSessionWith(sessionId, file, hash) {
	let names = [];
	try {
		names = fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith(".json") && n !== `${sessionId}.json`);
	} catch {
		return null;
	}
	for (const name of names) {
		const other = readJson(path.join(SESSIONS_DIR, name), null);
		const rec = other && other.tracked && other.tracked[file];
		if (rec && rec.hash === hash) return name.slice(0, -".json".length);
	}
	return null;
}

// Changed tracked files become notices, then the record moves to the new content
// so each overwrite is reported once.
function detectOverwrites(sessionId, session) {
	for (const [file, rec] of Object.entries(session.tracked)) {
		const snap = snapshot(file);
		if (!snap) {
			if (!fs.existsSync(file)) session.notices.push({ file, kind: "deleted", backup: rec.backup });
			delete session.tracked[file];
			continue;
		}
		if (snap.stat.mtimeMs === rec.mtimeMs && snap.stat.size === rec.size) continue;
		const hash = sha1(snap.content);
		if (hash !== rec.hash) {
			const by = otherSessionWith(sessionId, file, hash);
			session.notices.push({ file, kind: by ? `session ${by.slice(0, 8)}` : "studio", backup: rec.backup });
		}
		record(session, file);
	}
}

// Changes made while this session's own shell command ran are its own.
function adoptOwnChanges(session) {
	for (const file of Object.keys(session.tracked)) record(session, file);
}

function noticeText(notices, cwd) {
	const lines = notices.map((n) => {
		const shown = cwd ? path.relative(cwd, n.file) || n.file : n.file;
		const cause =
			n.kind === "deleted"
				? "was deleted outside your edits"
				: n.kind === "studio"
					? "was replaced by Studio sync or an edit outside this session"
					: `was replaced by Claude ${n.kind}`;
		return `- ${shown} ${cause}. Your last version: ${n.backup}`;
	});
	return [
		"OGSync: files you wrote this session changed underneath you.",
		...lines,
		"Studio wins sync conflicts: keep the current file. Diff it against your saved version and re-apply only the parts of your change that are still needed.",
	].join("\n");
}

function prune() {
	const cutoff = Date.now() - PRUNE_AFTER_MS;
	for (const dir of [SESSIONS_DIR, BACKUPS_DIR]) {
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const full = path.join(dir, name);
			try {
				if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
			} catch {}
		}
	}
}

function describeState(state) {
	if (!state) return "OGSync: daemon not running; it starts with the first ogsync tool call.";
	const places = state.places || [];
	if (places.length === 0) return "OGSync: daemon running, no Studio place connected.";
	const lines = places.map((p) => {
		const roles = (p.peers || []).map((peer) => peer.role || peer).join(", ") || "no peers";
		const playtest = p.playtest ? p.playtest.state : "unknown";
		return `- ${p.name || p.key} [${p.key}]: ${roles}; playtest ${playtest}`;
	});
	return ["OGSync: connected Studio places:", ...lines].join("\n");
}

// ---- dispatch ----

async function main(input) {
	const event = input.hook_event_name;
	const sessionId = input.session_id;
	const tool = input.tool_name;
	const file = input.tool_input && input.tool_input.file_path;

	if (event === "SessionStart") {
		prune();
		return respond({
			hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: describeState(await fetchState()) },
		});
	}
	if (!sessionId) return respond(null);

	if (event === "PreToolUse" && WRITE_TOOLS.has(tool) && file) {
		const reason = await playtestDenial(file);
		if (reason) {
			return respond({
				hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
			});
		}
		return respond(null);
	}

	const session = loadSession(sessionId);
	flushPending(sessionId, session);

	if (event === "PreToolUse" && tool === "Bash") {
		detectOverwrites(sessionId, session);
		writeJsonAtomic(sessionFile(sessionId), session);
		return respond(null);
	}

	if (event === "PostToolUse") {
		if (WRITE_TOOLS.has(tool) && file) delete session.tracked[path.resolve(file)];
		if (tool === "Bash") adoptOwnChanges(session);
		else detectOverwrites(sessionId, session);
		if (WRITE_TOOLS.has(tool) && file) queuePending(sessionId, file);
		const notices = session.notices;
		session.notices = [];
		writeJsonAtomic(sessionFile(sessionId), session);
		if (notices.length === 0) return respond(null);
		return respond({
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: noticeText(notices, input.cwd) },
		});
	}

	if (event === "Stop") {
		detectOverwrites(sessionId, session);
		const notices = session.notices;
		session.notices = [];
		writeJsonAtomic(sessionFile(sessionId), session);
		if (notices.length === 0 || input.stop_hook_active) return respond(null);
		return respond({ decision: "block", reason: noticeText(notices, input.cwd) });
	}

	return respond(null);
}

let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
	let input;
	try {
		input = JSON.parse(raw);
	} catch {
		process.exit(0);
	}
	main(input).catch(() => process.exit(0));
});
