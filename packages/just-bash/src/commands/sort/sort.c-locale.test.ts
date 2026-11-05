import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

const byCodePoint = (a: string, b: string) => {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
};

describe("sort C locale code point order", () => {
  it("orders surrogate pairs after U+E000-U+FFFF like UTF-8 bytes", async () => {
    const lines = [
      "\u{1F600}",
      "\uFFFD",
      "\uE000x",
      "z",
      "Z",
      "é",
      "a\u{10000}",
      "a\uFFFF",
      "a",
      "ab",
      "",
    ];
    const shell = new Bash({
      env: { LC_ALL: "C" },
      files: { "/in": `${lines.join("\n")}\n` },
    });
    const r = await shell.exec("sort /in");
    expect(r.stdout).toBe(`${[...lines].sort(byCodePoint).join("\n")}\n`);
  });

  it("matches the reference order on random strings", async () => {
    const pool = [
      "a",
      "B",
      "~",
      "\u00e9",
      "\u4e2d",
      "\uE001",
      "\uFFEE",
      "\u{1F600}",
      "\u{10400}",
      " ",
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % pool.length;
    };
    const lines = Array.from({ length: 400 }, () =>
      Array.from({ length: 1 + (rnd() % 5) }, () => pool[rnd()]).join(""),
    );
    const shell = new Bash({
      env: { LC_ALL: "C" },
      files: { "/in": `${lines.join("\n")}\n` },
    });
    const r = await shell.exec("sort /in");
    expect(r.stdout).toBe(`${[...lines].sort(byCodePoint).join("\n")}\n`);
  });

  it("fast path handles -r and -u like the comparator", async () => {
    const shell = new Bash({
      env: { LC_ALL: "C" },
      files: { "/in": "b\nA\na\nb\n\u00e9\nB\n" },
    });
    expect((await shell.exec("sort -r /in")).stdout).toBe(
      "\u00e9\nb\nb\na\nB\nA\n",
    );
    expect((await shell.exec("sort -u /in")).stdout).toBe(
      "A\nB\na\nb\n\u00e9\n",
    );
  });
});
