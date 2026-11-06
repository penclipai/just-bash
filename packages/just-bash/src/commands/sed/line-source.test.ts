import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { createSedLineSource } from "./line-source.js";

describe("sed input line cursor", () => {
  it("preserves empty lines and random lookups without splitting", () => {
    const lines = createSedLineSource("first\n\nlast\n");
    expect(lines.count()).toBe(3);
    expect(lines.get(2)).toBe("last");
    expect(lines.get(0)).toBe("first");
    expect(lines.get(1)).toBe("");
    expect(lines.has(3)).toBe(false);
    expect(createSedLineSource("").count()).toBe(0);
  });

  it("retains next-line and last-address behavior", async () => {
    const bash = new Bash({ files: { "/input": "a\nb\nc\nd\n" } });
    const result = await bash.exec("sed -n 'N;$p' /input; sed '2q' /input");
    expect(result).toMatchObject({
      stdout: "c\nd\na\nb\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
