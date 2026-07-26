// Compiles the daemon for every release target and zips each binary under the
// exact asset name the updater downloads from GitHub Releases:
//
//   dist/ogsync-windows-x64.exe -> dist/ogsync-windows-x64.exe.zip
//   dist/ogsync-linux-x64       -> dist/ogsync-linux-x64.zip
//   dist/ogsync-darwin-arm64    -> dist/ogsync-darwin-arm64.zip
//
// Run `bun run build:embed` first, otherwise the binary ships without the
// Studio plugin. `--only=<bun target>` builds a single target; the release
// matrix uses it to fan the targets out over runners.

import { mkdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "server/src/index.ts");
const DIST = resolve(ROOT, "dist");

interface Target {
  /** `bun build --target` value */
  bun: string;
  /** name in dist/; the release asset is this name + ".zip" */
  binary: string;
}

const TARGETS: Target[] = [
  { bun: "bun-windows-x64-baseline", binary: "ogsync-windows-x64.exe" },
  { bun: "bun-linux-x64-baseline", binary: "ogsync-linux-x64" },
  { bun: "bun-darwin-arm64", binary: "ogsync-darwin-arm64" },
];

function selectedTargets(): Target[] {
  const flag = "--only=";
  const only = process.argv.slice(2).find((arg) => arg.startsWith(flag))?.slice(flag.length);
  if (!only) return TARGETS;
  const target = TARGETS.find((t) => t.bun === only);
  if (!target) {
    throw new Error(`unknown --only target "${only}"; expected one of ${TARGETS.map((t) => t.bun).join(", ")}`);
  }
  return [target];
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`exited ${code}: ${cmd.join(" ")}`);
}

async function compile(target: Target): Promise<string> {
  const out = resolve(DIST, target.binary);
  await run([
    "bun",
    "build",
    ENTRY,
    "--compile",
    "--minify",
    "--sourcemap",
    `--target=${target.bun}`,
    `--outfile=${out}`,
  ]);
  return out;
}

/** Single-quoted PowerShell literal. */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function archive(binary: string): Promise<string> {
  const zip = `${binary}.zip`;
  await rm(zip, { force: true });
  await run(
    process.platform === "win32"
      ? [
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Compress-Archive -LiteralPath ${psLiteral(binary)} -DestinationPath ${psLiteral(zip)} -Force`,
        ]
      : ["zip", "-q", "-j", zip, binary],
  );
  return zip;
}

const targets = selectedTargets();

if (!(await Bun.file(ENTRY).exists())) {
  throw new Error("server/src/index.ts not found — nothing to compile");
}

await mkdir(DIST, { recursive: true });

for (const target of targets) {
  console.log(`build-binaries: ${target.bun} -> dist/${target.binary}`);
  const zip = await archive(await compile(target));
  console.log(`  ${Bun.file(zip).size} bytes  dist/${basename(zip)}`);
}
