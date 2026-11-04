import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("missing command hints", () => {
  it("adds a hint line but keeps status 127 and command -v failing", async () => {
    const env = new Bash({ commands: ["echo"] });
    const r = await env.exec(
      "python3 -c 'print(1)'; echo rc=$?; command -v pip >/dev/null; echo v=$?",
    );
    expect(r.stderr).toBe(
      "bash: python3: command not found\n" +
        "hint: Python is not available in this sandbox; use `node -e '...'` or `node file.js` for scripting instead\n",
    );
    expect(r.stdout).toBe("rc=127\nv=1\n");
  });

  it("explains package managers and native tools", async () => {
    const env = new Bash({ commands: ["echo"] });
    const r = await env.exec("pnpm i; sudo ls");
    expect(r.stderr).toContain("bash: pnpm: command not found\nhint: packages");
    expect(r.stderr).toContain(
      "bash: sudo: command not found\nhint: this browser sandbox",
    );
  });

  it("leaves unknown commands unchanged", async () => {
    const env = new Bash();
    const r = await env.exec("nosuchcmd");
    expect(r.stderr).toBe("bash: nosuchcmd: command not found\n");
    expect(r.exitCode).toBe(127);
  });
});
