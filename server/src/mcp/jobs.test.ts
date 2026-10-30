import { describe, expect, test } from "bun:test";
import { formatHandle, parseHandle, renderRun } from "./jobs.ts";

describe("job handles", () => {
  test("round-trip every context", () => {
    for (const handle of [
      { context: "edit" as const, id: "1" },
      { context: "server" as const, id: "42" },
      { context: "client" as const, id: "3" },
      { context: "client" as const, player: "Player1", id: "3" },
    ]) {
      expect(parseHandle(formatHandle(handle))).toEqual(handle);
    }
  });

  test("reject handles that cannot be routed", () => {
    expect(parseHandle("7")).toBeNull();
    expect(parseHandle("studio:7")).toBeNull();
    expect(parseHandle("server@Player1:7")).toBeNull();
    expect(parseHandle("server:")).toBeNull();
  });
});

describe("renderRun", () => {
  test("levels prefix non-info output, returns follow, notes last", () => {
    expect(
      renderRun({
        output: [{ level: "info", text: "a" }, { level: "warn", text: "b" }, "raw"],
        returns: [{ x: 1 }],
        dropped: 2,
        truncated: true,
      }),
    ).toEqual(["a", "[warn] b", "raw", '=> {"x":1}', "2 output lines dropped", "…more"]);
  });
});
