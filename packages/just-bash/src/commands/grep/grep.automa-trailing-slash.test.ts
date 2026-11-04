import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("grep -r with a trailing slash", () => {
  it("does not double the slash in file names", async () => {
    const env = new Bash({
      files: { "/w/src/a.js": "function a() {}\n", "/w/src/d/b.js": "x\n" },
      cwd: "/w",
    });
    const r = await env.exec("grep -rn function src/; grep -rl x src//");
    expect(r.stdout).toBe("src/a.js:1:function a() {}\nsrc/d/b.js\n");
  });
});
