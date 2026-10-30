import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS, PROTO_VERSION } from "./proto/types.ts";
import { Hub } from "./hub/hub.ts";
import { formatChecks, runDoctor, type Check } from "./doctor.ts";

const PLUGIN_HEADERS = { "x-ogsync-plugin": String(PROTO_VERSION) };

function levelOf(checks: Check[], title: string): string | undefined {
  return checks.find((c) => c.title === title)?.level;
}

describe("doctor", () => {
  let dir: string;
  let plugins: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ogsync-doctor-"));
    plugins = mkdtempSync(join(tmpdir(), "ogsync-plugins-"));
    process.env.OGSYNC_PLUGINS_DIR = plugins;
  });

  afterEach(() => {
    delete process.env.OGSYNC_PLUGINS_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(plugins, { recursive: true, force: true });
  });

  test("reports what is missing when nothing is set up", async () => {
    const checks = await runDoctor(dir, 1);
    expect(levelOf(checks, "project")).toBe("warn");
    expect(levelOf(checks, "plugin")).toBe("fail");
    expect(levelOf(checks, "daemon")).toBe("fail");
    // Every failure has to say what to do next, not just what is broken.
    for (const c of checks.filter((x) => x.level !== "ok")) expect(c.fix).toBeString();
    expect(formatChecks(checks)).toContain("failing");
  });

  test("flags a place that does not match target_place", async () => {
    writeFileSync(join(dir, "default.project.json"), JSON.stringify({ name: "t", tree: {} }));
    writeFileSync(join(plugins, "OGSync.rbxm"), "rbxm");
    writeFileSync(join(dir, "ogsync.toml"), '[bind]\ntarget_place = "Expected"\n');

    const config = structuredClone(CONFIG_DEFAULTS);
    config.bind.target_place = "Expected";
    const hub = new Hub({ config, version: "0.0.0-test", port: 0, longPollMs: 200 });
    hub.listen();
    try {
      await fetch(`http://127.0.0.1:${hub.port}/handshake`, {
        method: "POST",
        headers: PLUGIN_HEADERS,
        body: JSON.stringify({
          proto: PROTO_VERSION,
          session: "s1",
          role: "edit",
          pluginVersion: "0.0.0-test",
          placeId: 7,
          placeName: "SomethingElse",
        }),
      });
      const checks = await runDoctor(dir, hub.port);
      expect(levelOf(checks, "project")).toBe("ok");
      expect(levelOf(checks, "daemon")).toBe("warn"); // version differs from this CLI
      // The daemon serves every place; the project's target just does not match it.
      const binding = checks.find((c) => c.title === "binding");
      expect(binding?.level).toBe("fail");
      expect(binding?.detail).toContain("Expected");
      expect(binding?.fix).toContain("7 (SomethingElse)");
    } finally {
      hub.stop();
    }
  });

  test("notices other MCP plugins sharing the folder", async () => {
    writeFileSync(join(plugins, "OGSync.rbxm"), "rbxm");
    writeFileSync(join(plugins, "MCPPlugin.rbxmx"), "other");
    mkdirSync(join(dir, "sub"), { recursive: true });
    const checks = await runDoctor(dir, 1);
    const rival = checks.find((c) => c.detail.includes("MCPPlugin.rbxmx"));
    expect(rival?.level).toBe("warn");
  });
});
