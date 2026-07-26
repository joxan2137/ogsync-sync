import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng } from "./png.ts";

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 128];
const WHITE = [255, 255, 255, 255];

function pixels2x2(): Uint8Array {
  return Uint8Array.from([...RED, ...GREEN, ...BLUE, ...WHITE]);
}

describe("encodePng", () => {
  test("writes the PNG signature and an IHDR describing the image", () => {
    const png = encodePng(2, 2, pixels2x2());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(8)).toBe(13);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    expect(png[26]).toBe(0); // deflate
    expect(png[27]).toBe(0); // filter method
    expect(png[28]).toBe(0); // no interlace
  });

  test("IDAT inflates to filter-0 scanlines of the original pixels", () => {
    const png = encodePng(2, 2, pixels2x2());
    const idatStart = png.indexOf(Buffer.from("IDAT", "ascii"));
    const idatLength = png.readUInt32BE(idatStart - 4);
    const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLength));
    expect([...raw]).toEqual([0, ...RED, ...GREEN, 0, ...BLUE, ...WHITE]);
  });

  test("ends with an IEND chunk", () => {
    const png = encodePng(1, 1, Uint8Array.from(WHITE));
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });

  test("rejects a pixel buffer that does not match the size", () => {
    expect(() => encodePng(2, 2, Uint8Array.from(RED))).toThrow(/expected 16/);
  });
});
