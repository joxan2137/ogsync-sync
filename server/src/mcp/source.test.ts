import { describe, expect, test } from "bun:test";
import { contentHash, type Bridge } from "@proto/types";
import { splitChunks, STAGE_CHUNK_CHARS, wireText } from "./source.ts";

function stagingBridge() {
  const staged: Array<Record<string, unknown>> = [];
  const bridge: Bridge = {
    call: async (_op, args) => {
      staged.push(args as Record<string, unknown>);
      return {};
    },
    bound: () => null,
    sessions: () => [],
    onEvent: () => () => {},
  };
  return { bridge, staged };
}

describe("wireText", () => {
  test("small text goes inline as base64 of the LF form with its hash", async () => {
    const { bridge, staged } = stagingBridge();
    const wire = await wireText(bridge, "source", "local s = [[\r\nx]]\r", {});
    expect(staged).toHaveLength(0);
    expect(wire.chunks).toBe(1);
    const decoded = Buffer.from(wire.fields["source_b64"]!, "base64").toString("utf8");
    expect(decoded).toBe("local s = [[\nx]]\n");
    expect(wire.fields["source_hash"]).toBe(contentHash(decoded));
  });

  test("multi-byte text hashes its UTF-8 bytes, like the plugin", async () => {
    const { bridge } = stagingBridge();
    const wire = await wireText(bridge, "new", "print('żółw 🐢')", {});
    expect(Buffer.from(wire.fields["new_b64"]!, "base64").toString("utf8")).toBe("print('żółw 🐢')");
    expect(wire.hash).toBe(contentHash("print('żółw 🐢')"));
  });

  test("large text is staged in order and referenced by upload id", async () => {
    const { bridge, staged } = stagingBridge();
    const text = "-".repeat(STAGE_CHUNK_CHARS * 2);
    const wire = await wireText(bridge, "source", text, {});
    expect(wire.fields["source_b64"]).toBeUndefined();
    expect(staged.map((s) => s["index"])).toEqual([1, 2, 3]);
    expect(staged.every((s) => s["upload"] === wire.fields["source_upload"] && s["total"] === 3)).toBe(true);
    expect(Buffer.from(staged.map((s) => s["data"]).join(""), "base64").toString()).toBe(text);
  });
});

describe("splitChunks", () => {
  test("chunks split on whole base64 groups and keep empty text as one chunk", () => {
    expect(STAGE_CHUNK_CHARS % 4).toBe(0);
    expect(splitChunks("abcdefgh", 4)).toEqual(["abcd", "efgh"]);
    expect(splitChunks("")).toEqual([""]);
  });
});
