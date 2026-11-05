import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { stringFromBytes } from "./byte-string.js";
import {
  bytesFromUint8Array,
  decodeBytesToUtf8,
  encodeUtf8ToBytes,
  latin1FromBytes,
} from "./encoding.js";
import { fromBuffer, toBuffer } from "./fs/encoding.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("browser conversion bypasses Buffer and bounds arguments", () => {
  const storage = Uint8Array.from(
    { length: 8193 + 42 },
    (_, index) => index & 255,
  );
  const view = storage.subarray(23, 23 + 8193);
  const expected = Buffer.from(view).toString("latin1");
  vi.stubGlobal("__BROWSER__", true);
  vi.stubGlobal("Buffer", {
    from() {
      throw new Error("Browser conversion used Buffer polyfill");
    },
  });
  const spy = vi.spyOn(String, "fromCharCode");
  const result = stringFromBytes(view);
  expect(result).toBe(expected);
  view.fill(0);
  expect(result).toBe(expected);
  expect(spy).toHaveBeenCalled();
  for (const args of spy.mock.calls)
    expect(args.length).toBeLessThanOrEqual(8192);
});

it("Node conversion retains the native Buffer path", () => {
  const bytes = Uint8Array.of(0, 127, 128, 159, 255);
  const expected = Buffer.from(bytes).toString("latin1");
  vi.spyOn(String, "fromCharCode").mockImplementation(() => {
    throw new Error("Node conversion used portable batching");
  });
  expect(stringFromBytes(bytes)).toBe(expected);
});

it("browser wrappers retain raw bytes and UTF-8 fallback", () => {
  vi.stubGlobal("__BROWSER__", true);
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const raw = bytesFromUint8Array(bytes);
  expect(toBuffer(latin1FromBytes(raw), "latin1")).toEqual(bytes);
  expect(fromBuffer(bytes, "binary")).toBe(latin1FromBytes(raw));
  expect(decodeBytesToUtf8(raw)).toBe(latin1FromBytes(raw));
  expect(decodeBytesToUtf8(encodeUtf8ToBytes("\ufeff水"))).toBe("\ufeff水");
});

it("browser conversion checks byte limits before batching", () => {
  vi.stubGlobal("__BROWSER__", true);
  const bytes = Uint8Array.of(0, 128, 255);
  expect(latin1FromBytes(bytesFromUint8Array(bytes, 3))).toBe("\0\x80\xff");
  const spy = vi.spyOn(String, "fromCharCode");
  expect(() => bytesFromUint8Array(bytes, 2)).toThrow(RangeError);
  expect(spy).not.toHaveBeenCalled();
});

it("browser bundle preserves all bytes without Buffer", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./byte-string.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "conversion",
    define: { __BROWSER__: "true" },
    minifySyntax: true,
    write: false,
  });
  const code = result.outputFiles[0].text;
  expect(code).not.toContain("Buffer");
  const context = Object.create(null);
  context.TextDecoder = TextDecoder;
  const actual = runInNewContext(
    `${code}
    const storage = Uint8Array.from({ length: 280 }, (_, i) => (i - 11) & 255);
    Array.from(conversion.stringFromBytes(storage.subarray(11, 267)),
      char => char.charCodeAt(0));`,
    context,
  );
  expect(Array.from(actual)).toEqual(
    Array.from({ length: 256 }, (_, index) => index),
  );
});
