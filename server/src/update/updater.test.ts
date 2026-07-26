import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS } from "../proto/types.ts";
import { loadConfig } from "../config.ts";
import { PLUGIN_FILE, installPlugin, resolvePluginsDir, uninstallPlugin } from "./plugin-installer.ts";
import { compareSemver, normalizeVersion, parseChecksums, platformAsset } from "./updater.ts";

const PLUGINS_ENV = "OGSYNC_PLUGINS_DIR";

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("semver", () => {
  test("compares x.y.z numerically, not lexically", () => {
    expect(compareSemver("0.2.0", "0.1.9")).toBe(1);
    expect(compareSemver("0.10.0", "0.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.1", "1.1.0")).toBe(-1);
    expect(compareSemver("2.0.0", "10.0.0")).toBe(-1);
  });

  test("ignores a leading v and missing components", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
    expect(compareSemver("V2", "1.9.9")).toBe(1);
    expect(normalizeVersion(" v0.1.0 ")).toBe("0.1.0");
  });

  test("names one release asset per supported platform", () => {
    const asset = platformAsset();
    if (process.platform === "win32") expect(asset).toBe("ogsync-windows-x64.exe.zip");
    else if (process.platform === "linux") expect(asset).toBe("ogsync-linux-x64.zip");
    else if (process.platform === "darwin") expect(asset).toBe("ogsync-darwin-arm64.zip");
    else expect(asset).toBeNull();
  });
});

describe("checksums.txt", () => {
  test("indexes sha256 sums by asset name", () => {
    const sums = parseChecksums(
      [
        `${"a".repeat(64)}  ogsync-windows-x64.exe.zip`,
        `${"b".repeat(64)} *dist/ogsync-linux-x64.zip`,
        "not a checksum line",
      ].join("\n"),
    );
    expect(sums.get("ogsync-windows-x64.exe.zip")).toBe("a".repeat(64));
    expect(sums.get("ogsync-linux-x64.zip")).toBe("b".repeat(64));
    expect(sums.size).toBe(2);
  });
});

describe("plugins dir", () => {
  const saved = process.env[PLUGINS_ENV];
  afterEach(() => setEnv(PLUGINS_ENV, saved));

  test("OGSYNC_PLUGINS_DIR overrides the platform location", () => {
    const dir = temp("ogsync-plugins-env-");
    setEnv(PLUGINS_ENV, dir);
    expect(resolvePluginsDir()).toBe(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("blank override falls back to the platform location", () => {
    setEnv(PLUGINS_ENV, "   ");
    const dir = resolvePluginsDir();
    if (process.platform === "win32" || process.platform === "darwin") {
      expect(dir).toContain(join("Roblox", "Plugins"));
    } else {
      expect(dir).toBeNull();
    }
  });
});

describe("plugin install", () => {
  const saved = process.env[PLUGINS_ENV];
  let dir: string;

  beforeEach(() => {
    dir = temp("ogsync-plugins-");
    setEnv(PLUGINS_ENV, dir);
  });

  afterEach(() => {
    setEnv(PLUGINS_ENV, saved);
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes, byte-compares, then rewrites on change", async () => {
    const file = join(dir, PLUGIN_FILE);
    const first = new Uint8Array([1, 2, 3]);
    expect(await installPlugin(first)).toEqual({ status: "installed", file });
    expect(readFileSync(file)).toEqual(Buffer.from(first));

    expect(await installPlugin(new Uint8Array([1, 2, 3]))).toEqual({ status: "current", file });
    expect(await installPlugin(new Uint8Array([9]))).toEqual({ status: "updated", file });
    expect(uninstallPlugin()).toEqual({ status: "removed", file });
    expect(uninstallPlugin().status).toBe("skipped");
  });

  test("missing embedded bytes skip instead of failing", async () => {
    expect((await installPlugin(null)).status).toBe("skipped");
    expect((await installPlugin(new Uint8Array())).status).toBe("skipped");
  });
});

describe("config", () => {
  const savedPort = process.env["OGSYNC_PORT"];
  let dir: string;

  beforeEach(() => {
    dir = temp("ogsync-config-");
    setEnv("OGSYNC_PORT", undefined);
  });

  afterEach(() => {
    setEnv("OGSYNC_PORT", savedPort);
    rmSync(dir, { recursive: true, force: true });
  });

  function write(toml: string): void {
    writeFileSync(join(dir, "ogsync.toml"), toml);
  }

  test("returns defaults when ogsync.toml is absent", () => {
    expect(loadConfig(dir)).toEqual(CONFIG_DEFAULTS);
  });

  test("merges declared keys over the defaults", () => {
    write(`# project settings
[project]
name = "Demo"   # trailing comment

[daemon]
port = 4100

[bind]
target_place = "Place2"

[sync]
enabled = false
conflict = "prefer-fs"
debounce_fs_ms = 250

[update]
auto = false
`);
    const config = loadConfig(dir);
    expect(config.project.name).toBe("Demo");
    expect(config.project.file).toBe(CONFIG_DEFAULTS.project.file);
    expect(config.daemon.port).toBe(4100);
    expect(config.bind.target_place).toBe("Place2");
    expect(config.sync).toEqual({
      enabled: false,
      conflict: "prefer-fs",
      debounce_fs_ms: 250,
      debounce_studio_ms: CONFIG_DEFAULTS.sync.debounce_studio_ms,
    });
    expect(config.update.auto).toBe(false);
  });

  test("accepts a numeric target_place and rejects an unknown conflict policy", () => {
    write(`[bind]
target_place = 1818

[sync]
conflict = "prefer-vibes"
`);
    const config = loadConfig(dir);
    expect(config.bind.target_place).toBe(1818);
    expect(config.sync.conflict).toBe(CONFIG_DEFAULTS.sync.conflict);
  });

  test("OGSYNC_PORT wins over the config file", () => {
    write(`[daemon]
port = 4100
`);
    setEnv("OGSYNC_PORT", "5200");
    expect(loadConfig(dir).daemon.port).toBe(5200);
    setEnv("OGSYNC_PORT", "not-a-port");
    expect(loadConfig(dir).daemon.port).toBe(4100);
  });

  test("unparsable TOML degrades to defaults", () => {
    write("[sync\nenabled = ");
    expect(loadConfig(dir)).toEqual(CONFIG_DEFAULTS);
  });

  test("reads a project directory scaffolded next to sources", () => {
    mkdirSync(join(dir, "src", "server"), { recursive: true });
    write(`[project]
name = "Scaffolded"
file = "custom.project.json"
`);
    const config = loadConfig(dir);
    expect(config.project).toEqual({ name: "Scaffolded", file: "custom.project.json" });
  });
});
