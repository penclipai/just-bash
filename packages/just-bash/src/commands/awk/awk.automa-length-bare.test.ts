import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("awk bare length", () => {
  it("treats bare length as length($0) in a pattern", async () => {
    const env = new Bash();
    const r = await env.exec(`printf 'ab\\nabcdef\\n' | awk 'length > 3'`);
    expect(r.stdout).toBe("abcdef\n");
    expect(r.exitCode).toBe(0);
  });

  it("supports bare length in actions and expressions", async () => {
    const env = new Bash();
    const r = await env.exec(
      `printf 'abc\\nde\\n' | awk '{ print length, length + 1; n += length } END { print n }'`,
    );
    expect(r.stdout).toBe("3 4\n2 3\n5\n");
  });

  it("keeps length(x) and length() working", async () => {
    const env = new Bash();
    const r = await env.exec(`echo hello | awk '{ print length(), length("xy") }'`);
    expect(r.stdout).toBe("5 2\n");
  });
});
