// Starts the ogsync binary for Claude Code. The plugin cache holds no binary,
// so it is resolved at launch: OGSYNC_BIN, then ~/.ogsync/bin, then PATH, then
// a source checkout named by OGSYNC_REPO (run through bun).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const exe = process.platform === "win32" ? "ogsync.exe" : "ogsync";

function resolveCommand() {
	if (process.env.OGSYNC_BIN) return [process.env.OGSYNC_BIN, []];
	const installed = join(homedir(), ".ogsync", "bin", exe);
	if (existsSync(installed)) return [installed, []];
	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ogsync"], { encoding: "utf8" });
	const onPath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : "";
	if (onPath) return [onPath, []];
	if (process.env.OGSYNC_REPO) return ["bun", ["run", join(process.env.OGSYNC_REPO, "server", "src", "index.ts")]];
	return [null, []];
}

const [command, prefix] = resolveCommand();
if (!command) {
	process.stderr.write(
		"ogsync: no binary found. Install it to ~/.ogsync/bin, put it on PATH, or set OGSYNC_BIN / OGSYNC_REPO.\n"
	);
	process.exit(1);
}

const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" };
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) delete env[key];

const child = spawn(command, [...prefix, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on("error", (err) => {
	process.stderr.write(`ogsync: failed to start ${command}: ${err.message}\n`);
	process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
