import { describe, expect, test } from "bun:test";
import {
  capText,
  compactPaths,
  fmtValue,
  instBlock,
  lines,
  moreLine,
  numberLines,
  renderTree,
  row,
} from "./fmt.ts";

describe("capText", () => {
  test("passes short text through untouched", () => {
    expect(capText("hello", 10)).toBe("hello");
  });

  test("cuts at the last line break and appends the cursor hint", () => {
    const text = "aaaa\nbbbb\ncccc\ndddd";
    expect(capText(text, 12, 42)).toBe("aaaa\nbbbb\n…more: pass cursor=42");
  });

  test("appends a bare more marker without a cursor", () => {
    expect(capText("0123456789", 4)).toBe("0123\n…more");
    expect(moreLine()).toBe("…more");
  });
});

describe("numberLines", () => {
  test("numbers from the given offset with right-aligned width", () => {
    expect(numberLines(["a", "b"], 9)).toBe(" 9\ta\n10\tb");
  });

  test("accepts a raw source string", () => {
    expect(numberLines("x\ny")).toBe("1\tx\n2\ty");
  });
});

describe("row", () => {
  test("renders path<TAB>field=value and drops undefined", () => {
    expect(row("game.Workspace.Part", { class: "Part", size: [1, 2, 3], nope: undefined })).toBe(
      "game.Workspace.Part\tclass=Part size=[1,2,3]",
    );
  });

  test("renders a bare path when there are no fields", () => {
    expect(row("game.Workspace")).toBe("game.Workspace");
  });
});

describe("instBlock", () => {
  test("headers with (Class) and indents entries by two spaces", () => {
    expect(instBlock("game.Workspace.Part", "Part", { Anchored: true, Skip: undefined })).toEqual([
      "game.Workspace.Part (Part)",
      "  Anchored=true",
    ]);
  });
});

describe("renderTree", () => {
  test("indents children by two spaces and annotates lines/counts", () => {
    const out = renderTree({
      name: "game",
      class: "DataModel",
      children: [
        { name: "ServerScriptService", class: "ServerScriptService", count: 2 },
        { name: "Main", class: "Script", lines: 42 },
      ],
    });
    expect(out).toEqual([
      "game DataModel",
      "  ServerScriptService ServerScriptService [2]",
      "  Main Script #42",
    ]);
  });
});

describe("compactPaths", () => {
  test("collapses consecutive numbered siblings", () => {
    expect(compactPaths(["a.Part1", "a.Part2", "a.Part3", "a.Other"])).toEqual([
      "a.Part[1..3]",
      "a.Other",
    ]);
  });

  test("keeps non-consecutive runs separate", () => {
    expect(compactPaths(["p1", "p2", "p7"])).toEqual(["p[1..2]", "p7"]);
  });
});

describe("fmtValue / lines", () => {
  test("serializes rojo-style values compactly", () => {
    expect(fmtValue([0, 5, 0])).toBe("[0,5,0]");
    expect(fmtValue("Neon")).toBe("Neon");
    expect(fmtValue(null)).toBe("null");
    expect(fmtValue(true)).toBe("true");
  });

  test("flattens and drops undefined parts", () => {
    expect(lines("a", ["b", "c"], undefined)).toBe("a\nb\nc");
  });
});
