import { describe, expect, it } from "vitest";
import { createWcCounter } from "./byte-counts.js";

describe("wc byte blocks", () => {
  it("counts words and lines across blocks", () => {
    const counter = createWcCounter({ lines: true, words: true, chars: false });
    counter.update(new TextEncoder().encode("one tw"));
    counter.update(new TextEncoder().encode("o\nthree"));
    expect(counter.finish()).toEqual({
      lines: 1,
      words: 3,
      third: 13,
      bytes: 13,
    });
  });

  it("decodes characters split across UTF-8 blocks", () => {
    const counter = createWcCounter({
      lines: false,
      words: false,
      chars: true,
    });
    const bytes = new TextEncoder().encode("\ufeffé😀");
    for (const byte of bytes) counter.update(new Uint8Array([byte]));
    expect(counter.finish()).toEqual({
      lines: 0,
      words: 0,
      third: 3,
      bytes: 9,
    });
  });

  it("keeps the whole-input invalid UTF-8 fallback", () => {
    const counter = createWcCounter({
      lines: false,
      words: false,
      chars: true,
    });
    counter.update(new TextEncoder().encode("é"));
    counter.update(new Uint8Array([255]));
    expect(counter.finish()).toEqual({
      lines: 0,
      words: 0,
      third: 3,
      bytes: 3,
    });
  });
});
