// Self-update against GitHub Releases (Argon pattern): throttled + ETag'd
// check, platform asset download, sha256 verification against checksums.txt,
// then a rename dance over the running executable.
//
// Rules that must not regress: a failed or rate-limited check is reported as
// "inconclusive", never as "no update"; nothing is ever written when the
// executable's directory is read-only; the check never blocks serve startup.

import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { OgsyncConfig } from "../proto/types.ts";
import { ogsyncHome } from "../config.ts";
import { log } from "../log.ts";
import { VERSION } from "../version.ts";

export const REPO = "joxan2137/ogsync-sync";

const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECKSUMS_ASSET = "checksums.txt";
const STATE_FILE = "update.json";
const CHECK_THROTTLE_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
export const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

/** Set once a swap lands: the new image only takes effect on restart. */
let installedPendingRestart: string | null = null;
/** Guards against the 6 h timer starting a second concurrent swap. */
let installInFlight = false;

interface UpdateState {
  lastChecked?: number;
  etag?: string;
  skippedVersion?: string;
}

export type UpdateOutcome =
  | { status: "disabled" }
  | { status: "throttled"; nextCheckIn: number }
  | { status: "current"; version: string }
  | { status: "inconclusive"; reason: string }
  | { status: "available"; version: string; reason: string }
  | { status: "updated"; version: string };

export interface UpdateCheckOptions {
  /** update.auto from ogsync.toml; ignored when force is set. */
  auto?: boolean;
  /** `ogsync update`: bypass throttle, ETag and skippedVersion. */
  force?: boolean;
}

interface ReleaseAsset {
  name: string;
  url: string;
}

interface Release {
  tag: string;
  etag: string | null;
  assets: ReleaseAsset[];
}

type ReleaseFetch =
  | ({ kind: "release" } & Release)
  | { kind: "unchanged"; etag: string | null }
  | { kind: "inconclusive"; reason: string };

export async function checkForUpdate(opts: UpdateCheckOptions = {}): Promise<UpdateOutcome> {
  const force = opts.force === true;
  if (!force && opts.auto === false) return { status: "disabled" };

  const state = readState();
  const elapsed = Date.now() - (state.lastChecked ?? 0);
  if (!force && elapsed < CHECK_THROTTLE_MS) {
    return { status: "throttled", nextCheckIn: CHECK_THROTTLE_MS - elapsed };
  }

  if (installedPendingRestart !== null) {
    return { status: "available", version: installedPendingRestart, reason: "installed; restart ogsync to run it" };
  }
  if (installInFlight) return { status: "inconclusive", reason: "an install is already running" };

  const fetched = await fetchLatestRelease(state.etag, force);
  if (fetched.kind === "inconclusive") return { status: "inconclusive", reason: fetched.reason };
  writeState({ ...state, lastChecked: Date.now(), etag: fetched.etag ?? state.etag });
  if (fetched.kind === "unchanged") return { status: "current", version: VERSION };

  const latest = normalizeVersion(fetched.tag);
  if (compareSemver(latest, VERSION) <= 0) return { status: "current", version: VERSION };
  if (!force && state.skippedVersion === latest) {
    return { status: "available", version: latest, reason: "previously skipped; run `ogsync update` to retry" };
  }
  return installRelease(fetched, latest, state);
}

export async function checkAuto(config: OgsyncConfig): Promise<void> {
  reportOutcome(await checkForUpdate({ auto: config.update.auto }));
}

/** Runs a check now, then every 6 h. Returns a stop function. */
export function scheduleAutoUpdates(config: OgsyncConfig): () => void {
  void checkAuto(config);
  const timer = setInterval(() => void checkAuto(config), PERIODIC_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function reportOutcome(outcome: UpdateOutcome): void {
  switch (outcome.status) {
    case "disabled":
      log.debug("auto-update disabled (update.auto = false)");
      return;
    case "throttled":
      log.debug(`update check throttled, next in ${Math.round(outcome.nextCheckIn / 60_000)}m`);
      return;
    case "current":
      log.info(`ogsync ${outcome.version} is up to date`);
      return;
    case "inconclusive":
      log.info(`update check inconclusive: ${outcome.reason}`);
      return;
    case "available":
      log.warn(`ogsync ${outcome.version} is available but was not installed: ${outcome.reason}`);
      return;
    case "updated":
      log.info(`updated to ogsync ${outcome.version} — restart ogsync to run it`);
      return;
  }
}

/** Deletes the `.old`/`.new` binaries left behind by a previous swap. */
export function removeStaleBackup(): void {
  for (const suffix of [".old", ".new"]) {
    const stale = `${process.execPath}${suffix}`;
    try {
      rmSync(stale, { force: true });
    } catch (err) {
      log.debug(`cannot remove ${stale}:`, err);
    }
  }
}

/** -1 / 0 / 1 on x.y.z only; prerelease and build suffixes are ignored. */
export function compareSemver(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** null when this platform/arch has no published asset. */
export function platformAsset(): string | null {
  if (process.platform === "win32") return "ogsync-windows-x64.exe.zip";
  if (process.platform === "linux") return "ogsync-linux-x64.zip";
  if (process.platform === "darwin") return "ogsync-darwin-arm64.zip";
  return null;
}

function versionParts(version: string): number[] {
  return normalizeVersion(version)
    .split(".")
    .slice(0, 3)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

async function fetchLatestRelease(etag: string | undefined, force: boolean): Promise<ReleaseFetch> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": `ogsync/${VERSION}`,
    "x-github-api-version": "2022-11-28",
  };
  if (etag !== undefined && !force) headers["if-none-match"] = etag;
  const token = process.env["GITHUB_TOKEN"]?.trim();
  if (token !== undefined && token !== "") headers["authorization"] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(LATEST_RELEASE_URL, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    return { kind: "inconclusive", reason: `network error: ${message(err)}` };
  }
  if (res.status === 304) return { kind: "unchanged", etag: etag ?? null };
  if (res.status === 403 || res.status === 429) {
    return { kind: "inconclusive", reason: `github rate limited (HTTP ${res.status}); set GITHUB_TOKEN to raise the limit` };
  }
  if (!res.ok) return { kind: "inconclusive", reason: `github returned HTTP ${res.status}` };

  try {
    const body = (await res.json()) as {
      tag_name?: string;
      assets?: { name?: string; browser_download_url?: string }[];
    };
    const tag = body.tag_name?.trim();
    if (tag === undefined || tag === "") return { kind: "inconclusive", reason: "latest release has no tag_name" };
    const assets = (body.assets ?? []).flatMap((asset) =>
      asset.name !== undefined && asset.browser_download_url !== undefined
        ? [{ name: asset.name, url: asset.browser_download_url }]
        : [],
    );
    return { kind: "release", tag, etag: res.headers.get("etag"), assets };
  } catch (err) {
    return { kind: "inconclusive", reason: `unreadable release json: ${message(err)}` };
  }
}

async function installRelease(release: Release, version: string, state: UpdateState): Promise<UpdateOutcome> {
  const assetName = platformAsset();
  if (assetName === null) {
    return notInstalled(version, state, `no release asset for ${process.platform}/${process.arch}`);
  }
  if (!isStandaloneBinary()) {
    return { status: "available", version, reason: "running from source, not a compiled binary — update your checkout" };
  }
  const exe = process.execPath;
  const exeDir = dirname(exe);
  if (!isWritable(exeDir)) {
    return notInstalled(version, state, `${exeDir} is not writable — reinstall via your package manager to update`);
  }
  installInFlight = true;
  try {
    return await performInstall(release, version, state, assetName, exe);
  } finally {
    installInFlight = false;
  }
}

async function performInstall(
  release: Release,
  version: string,
  state: UpdateState,
  assetName: string,
  exe: string,
): Promise<UpdateOutcome> {

  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset) return notInstalled(version, state, `release ${version} has no ${assetName}`);
  const checksums = release.assets.find((candidate) => candidate.name === CHECKSUMS_ASSET);
  if (!checksums) return notInstalled(version, state, `release ${version} has no ${CHECKSUMS_ASSET}`);

  const staging = mkdtempSync(join(tmpdir(), "ogsync-update-"));
  try {
    const archive = await download(asset.url);
    const expected = parseChecksums(await downloadText(checksums.url)).get(assetName);
    if (expected === undefined) return notInstalled(version, state, `${CHECKSUMS_ASSET} has no entry for ${assetName}`);
    const actual = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
    if (actual !== expected) {
      return notInstalled(version, state, `sha256 mismatch for ${assetName} (expected ${expected}, got ${actual})`);
    }

    const archivePath = join(staging, assetName);
    writeFileSync(archivePath, archive);
    await extract(archivePath, staging);
    const binary = findBinary(staging, assetName);
    if (binary === null) return notInstalled(version, state, `${assetName} did not contain an ogsync binary`);

    swapBinary(exe, readFileSync(binary));
    writeState({ lastChecked: Date.now(), etag: release.etag ?? state.etag });
    // The new image only runs after a restart; further checks this process
    // would re-download and re-swap the same release.
    installedPendingRestart = version;
    return { status: "updated", version };
  } catch (err) {
    // Only integrity failures earn a permanent skip; transient IO and network
    // faults must be retried on the next window.
    return notInstalled(version, state, message(err), false);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * `permanent` marks a release as broken (bad checksum, missing asset) so it is
 * not re-downloaded every 6 h. Transient failures leave it eligible.
 */
function notInstalled(
  version: string,
  state: UpdateState,
  reason: string,
  permanent = true,
): UpdateOutcome {
  writeState({
    ...state,
    lastChecked: Date.now(),
    ...(permanent ? { skippedVersion: version } : {}),
  });
  return { status: "available", version, reason };
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "user-agent": `ogsync/${VERSION}`, accept: "application/octet-stream" },
    redirect: "follow",
    // A hung CDN read must not stall the daemon indefinitely.
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadText(url: string): Promise<string> {
  return (await download(url)).toString("utf8");
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const parsed = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (parsed) sums.set(basename(parsed[2]!.trim()), parsed[1]!.toLowerCase());
  }
  return sums;
}

// Bun 1.3 has no zip API; shelling out is the accepted v1 cost.
async function extract(archive: string, dir: string): Promise<void> {
  const cmd =
    process.platform === "win32"
      ? [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath '${quoteForPowershell(archive)}' -DestinationPath '${quoteForPowershell(dir)}' -Force`,
        ]
      : ["unzip", "-o", archive, "-d", dir];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${cmd[0]} failed (exit ${code}): ${stderr.trim()}`);
  }
}

function findBinary(dir: string, assetName: string): string | null {
  const expected = assetName.replace(/\.zip$/, "");
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name !== assetName);
  const match = files.find((entry) => entry.name === expected) ?? files.find((entry) => entry.name.startsWith("ogsync"));
  return match ? join(dir, match.name) : null;
}

function swapBinary(exe: string, bytes: Buffer): void {
  if (process.platform === "win32") {
    // Stage the new image first so the window with no executable at `exe` is a
    // single rename wide, and a locked leftover `.old` cannot strand us.
    const staged = `${exe}.new`;
    const backup = `${exe}.old`;
    writeFileSync(staged, bytes);
    try {
      rmSync(backup, { force: true });
    } catch {
      // A previous .old still running as an image; park this one beside it.
    }
    const parked = existsSync(backup) ? `${exe}.old-${Date.now().toString(36)}` : backup;
    renameSync(exe, parked); // Windows allows renaming a running image, not overwriting it
    try {
      renameSync(staged, exe);
    } catch (err) {
      renameSync(parked, exe);
      rmSync(staged, { force: true });
      throw err;
    }
    return;
  }
  const staged = `${exe}.new`;
  writeFileSync(staged, bytes, { mode: 0o755 });
  chmodSync(staged, 0o755);
  renameSync(staged, exe); // atomic swap; the running process keeps its old inode
}

// `bun run server/src/index.ts` reports the bun binary as execPath — replacing
// that would clobber the user's runtime, so self-update is compiled-only.
function isStandaloneBinary(): boolean {
  if (Bun.main.includes("$bunfs") || Bun.main.includes("~BUN")) return true;
  return !basename(process.execPath).toLowerCase().startsWith("bun");
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function stateFile(): string {
  return join(ogsyncHome(), STATE_FILE);
}

function readState(): UpdateState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as UpdateState) : {};
  } catch {
    return {};
  }
}

function writeState(state: UpdateState): void {
  try {
    writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    log.debug("cannot persist update state:", err);
  }
}

function quoteForPowershell(value: string): string {
  return value.replaceAll("'", "''");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
