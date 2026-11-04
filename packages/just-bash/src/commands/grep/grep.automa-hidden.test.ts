import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("grep -r with hidden entries", () => {
  it("searches hidden files and directories like GNU grep", async () => {
    const env = new Bash({
      files: { "/w/.env": "k=1\n", "/w/.cfg/c": "k=2\n", "/w/v": "k=3\n" },
      cwd: "/w",
    });
    const r = await env.exec("grep -rl k . | sort");
    expect(r.stdout).toBe("./.cfg/c\n./.env\n./v\n");
  });
});
