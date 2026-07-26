import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentHash } from "../proto/types.ts";
import {
  FOLDER_CLASS,
  FOLDER_HASH,
  buildInst,
  isIgnoredFile,
  isUnder,
  joinInst,
  loadProject,
  splitInst,
} from "./project.ts";

const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ogsync-project-"));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  return dir;
}

const PROJECT = JSON.stringify({
  name: "OGSyncTest",
  tree: {
    $className: "DataModel",
    ReplicatedStorage: { Shared: { $path: "src/shared" } },
    ServerScriptService: {
      Server: { $path: "src/server", $ignoreUnknownInstances: true },
      Single: { $path: "src/loose/Solo.server.luau" },
    },
    StarterPlayer: {
      StarterPlayerScripts: { Client: { $path: "src/client", $properties: {} } },
    },
  },
});

const TREE: Record<string, string> = {
  "default.project.json": PROJECT,
  "src/shared/Hello.luau": "return 1\n",
  "src/shared/My.Mod.luau": "return 'dots'\n",
  "src/shared/Nested/Deep.luau": "return 2\n",
  "src/shared/Nested/Handler.server.luau": "print('h')\n",
  "src/shared/Promoted/init.server.luau": "print('init')\n",
  "src/shared/Promoted/Child.client.luau": "print('child')\n",
  "src/shared/notes.txt": "not a script\n",
  "src/shared/data.json": "{}\n",
  "src/shared/sheet.csv": "a,b\n",
  "src/server/Main.server.luau": "print('main')\n",
  "src/client/Boot.client.luau": "print('boot')\n",
  "src/loose/Solo.server.luau": "print('solo')\n",
};

const SHARED = "game.ReplicatedStorage.Shared";

describe("path grammar", () => {
  test("plain names use dots, odd names use brackets", () => {
    expect(joinInst("game.Workspace", "Part")).toBe("game.Workspace.Part");
    expect(joinInst("game.Workspace", "My.Part")).toBe('game.Workspace["My.Part"]');
    expect(joinInst("game.Workspace", "2Fast")).toBe('game.Workspace["2Fast"]');
  });

  test("split/build round-trips bracketed segments", () => {
    const segments = ["game", "Workspace", "My.Part", 'Quote"Name', "Plain"];
    const path = buildInst(segments);
    expect(splitInst(path)).toEqual(segments);
  });

  test("isUnder respects segment boundaries", () => {
    expect(isUnder(`${SHARED}.Hello`, SHARED)).toBe(true);
    expect(isUnder(`${SHARED}["My.Mod"]`, SHARED)).toBe(true);
    expect(isUnder(SHARED, SHARED)).toBe(true);
    expect(isUnder("game.ReplicatedStorage.SharedOther", SHARED)).toBe(false);
  });

  test("dotfiles and conflict backups are ignored", () => {
    expect(isIgnoredFile(".ogsync/shadow.json")).toBe(true);
    expect(isIgnoredFile("src/shared/.Hello.luau.ogsync-tmp")).toBe(true);
    expect(isIgnoredFile("src/shared/Hello.conflict-1234.luau")).toBe(true);
    expect(isIgnoredFile("src/shared/Hello.luau")).toBe(false);
  });
});

describe("mapping", () => {
  const project = loadProject(fixture(TREE), "default.project.json");

  test("syncRoots lists every mapped root", () => {
    expect(project.syncRoots()).toEqual([
      "game.ReplicatedStorage.Shared",
      "game.ServerScriptService.Server",
      "game.ServerScriptService.Single",
      "game.StarterPlayer.StarterPlayerScripts.Client",
    ]);
  });

  test("watchDirs covers the mapped directories", () => {
    expect(project.watchDirs()).toEqual(["src/client", "src/server", "src/shared"]);
  });

  test("file conventions map to Roblox classes", () => {
    expect(project.fileToInst("src/shared/Hello.luau")).toEqual({
      path: `${SHARED}.Hello`,
      class: "ModuleScript",
      kind: "module",
    });
    expect(project.fileToInst("src/server/Main.server.luau")).toEqual({
      path: "game.ServerScriptService.Server.Main",
      class: "Script",
      kind: "server",
    });
    expect(project.fileToInst("src/client/Boot.client.luau")).toEqual({
      path: "game.StarterPlayer.StarterPlayerScripts.Client.Boot",
      class: "LocalScript",
      kind: "client",
    });
  });

  test("nested directories become Folders", () => {
    expect(project.fileToInst("src/shared/Nested")).toEqual({
      path: `${SHARED}.Nested`,
      class: FOLDER_CLASS,
      kind: "folder",
    });
    expect(project.fileToInst("src/shared/Nested/Handler.server.luau")?.path).toBe(
      `${SHARED}.Nested.Handler`,
    );
  });

  test("init files promote their directory", () => {
    expect(project.fileToInst("src/shared/Promoted/init.server.luau")).toEqual({
      path: `${SHARED}.Promoted`,
      class: "Script",
      kind: "server",
    });
    expect(project.instToFile(`${SHARED}.Promoted`)).toBe("src/shared/Promoted/init.server.luau");
    expect(project.instToFile(`${SHARED}.Promoted.Child`)).toBe(
      "src/shared/Promoted/Child.client.luau",
    );
  });

  test("names with dots use bracket paths and round-trip", () => {
    const mapped = project.fileToInst("src/shared/My.Mod.luau");
    expect(mapped?.path).toBe(`${SHARED}["My.Mod"]`);
    expect(project.instToFile(mapped?.path ?? "")).toBe("src/shared/My.Mod.luau");
  });

  test("a $path pointing at one file maps only that instance", () => {
    expect(project.instToFile("game.ServerScriptService.Single")).toBe(
      "src/loose/Solo.server.luau",
    );
    expect(project.fileToInst("src/loose/Solo.server.luau")?.path).toBe(
      "game.ServerScriptService.Single",
    );
    expect(project.instToFile("game.ServerScriptService.Single.Child")).toBeNull();
  });

  test("unmapped instances and unsupported files map to null", () => {
    expect(project.instToFile("game.Workspace.Thing")).toBeNull();
    expect(project.fileToInst("src/shared/data.json")).toBeNull();
    expect(project.fileToInst("README.md")).toBeNull();
  });

  test("class picks the extension for files that do not exist yet", () => {
    expect(project.instToFile(`${SHARED}.Fresh`, "LocalScript")).toBe(
      "src/shared/Fresh.client.luau",
    );
    expect(project.instToFile(`${SHARED}.Fresh`, "Script")).toBe("src/shared/Fresh.server.luau");
    expect(project.instToFile(`${SHARED}.Fresh`, "Script", "plugin")).toBe(
      "src/shared/Fresh.plugin.luau",
    );
    expect(project.instToFile(`${SHARED}.Fresh`, "ModuleScript")).toBe("src/shared/Fresh.luau");
    expect(project.instToFile(`${SHARED}.Fresh`, FOLDER_CLASS)).toBe("src/shared/Fresh");
    expect(project.instToFile(`${SHARED}.Deep.Down.Here`, "ModuleScript")).toBe(
      "src/shared/Deep/Down/Here.luau",
    );
  });

  test("ancestorsOf lists the folders a child needs, root first", () => {
    expect(project.ancestorsOf(`${SHARED}.Nested.Handler`)).toEqual([SHARED, `${SHARED}.Nested`]);
    expect(project.ancestorsOf(`${SHARED}.Hello`)).toEqual([SHARED]);
  });
});

describe("scanFs", () => {
  const project = loadProject(fixture(TREE), "default.project.json");
  const scan = project.scanFs();

  test("every mapped script is scanned with its hash", () => {
    expect(scan.get(`${SHARED}.Hello`)).toEqual({
      file: "src/shared/Hello.luau",
      class: "ModuleScript",
      source: "return 1\n",
      hash: contentHash("return 1\n"),
    });
    expect(scan.get("game.ServerScriptService.Single")?.file).toBe("src/loose/Solo.server.luau");
  });

  test("directories are Folders and promoted directories keep the init file", () => {
    expect(scan.get(`${SHARED}.Nested`)).toEqual({
      file: "src/shared/Nested",
      class: FOLDER_CLASS,
      source: "",
      hash: FOLDER_HASH,
    });
    expect(scan.get(`${SHARED}.Promoted`)).toEqual({
      file: "src/shared/Promoted/init.server.luau",
      class: "Script",
      source: "print('init')\n",
      hash: contentHash("print('init')\n"),
    });
    expect(scan.get(SHARED)?.class).toBe(FOLDER_CLASS);
  });

  test("every scanned entry round-trips through the mapping", () => {
    for (const [path, entry] of scan) {
      expect(project.fileToInst(entry.file)?.path).toBe(path);
      expect(project.instToFile(path)).toBe(entry.file);
    }
  });

  test("unsupported file types are counted, not synced", () => {
    expect([...scan.keys()].some((p) => p.endsWith("notes"))).toBe(false);
    expect(Object.fromEntries(project.ignoredCounts())).toEqual({
      ".txt": 1,
      ".json": 1,
      ".csv": 1,
    });
  });
});

describe("edge cases", () => {
  test("only the highest-priority init file promotes a directory", () => {
    const dir = fixture({
      "default.project.json": JSON.stringify({
        name: "T",
        tree: { ReplicatedStorage: { Shared: { $path: "src" } } },
      }),
      "src/Both/init.luau": "return 'module'\n",
      "src/Both/init.server.luau": "print('shadowed')\n",
    });
    const project = loadProject(dir, "default.project.json");
    const scan = project.scanFs();
    expect(scan.get("game.ReplicatedStorage.Shared.Both")).toEqual({
      file: "src/Both/init.luau",
      class: "ModuleScript",
      source: "return 'module'\n",
      hash: contentHash("return 'module'\n"),
    });
    expect(project.fileToInst("src/Both/init.server.luau")).toBeNull();
  });

  test("a nested default.project.json extends the tree", () => {
    const dir = fixture({
      "default.project.json": JSON.stringify({
        name: "Outer",
        tree: { ReplicatedStorage: { Pkg: { $path: "packages/thing" } } },
      }),
      "packages/thing/default.project.json": JSON.stringify({
        name: "Thing",
        tree: { $path: "src" },
      }),
      "packages/thing/src/Api.luau": "return {}\n",
    });
    const project = loadProject(dir, "default.project.json");
    expect(project.syncRoots()).toEqual(["game.ReplicatedStorage.Pkg"]);
    expect(project.fileToInst("packages/thing/src/Api.luau")?.path).toBe(
      "game.ReplicatedStorage.Pkg.Api",
    );
    expect(project.instToFile("game.ReplicatedStorage.Pkg.Api")).toBe(
      "packages/thing/src/Api.luau",
    );
  });

  test("$className overrides the mapped root class", () => {
    const dir = fixture({
      "default.project.json": JSON.stringify({
        name: "T",
        tree: { ServerScriptService: { Boot: { $path: "src", $className: "Configuration" } } },
      }),
      "src/Inner.luau": "return 1\n",
    });
    const project = loadProject(dir, "default.project.json");
    expect(project.fileToInst("src")?.class).toBe("Configuration");
    expect(project.fileToInst("src/Inner.luau")?.class).toBe("ModuleScript");
  });

  test("a project without a tree is rejected", () => {
    const dir = fixture({ "default.project.json": JSON.stringify({ name: "T" }) });
    expect(() => loadProject(dir, "default.project.json")).toThrow(/missing "tree"/);
  });
});
