import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("compound output endpoint ownership", () => {
  it.each([
    "exit",
    "return",
  ])("keeps escaped output during %s unwind", async (operation) => {
    const bash = new Bash({ cwd: "/" });
    const loop = `while true; do echo o; echo e >&2; ${operation} 7; done 2>&1 >/out`;
    const script = operation === "return" ? `f() { ${loop}; }; f` : loop;
    const result = await bash.exec(script);
    expect(result).toMatchObject({ stdout: "e\n", stderr: "", exitCode: 7 });
    expect(await bash.readFile("/out")).toBe("o\n");
  });

  it("appends fresh unwind diagnostics to the existing endpoint", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      'set -u; while true; do echo o; echo e >&2; echo "$missing"; done >/out 2>/errors',
    );
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 127 });
    expect(await bash.readFile("/out")).toBe("o\n");
    expect(await bash.readFile("/errors")).toBe(
      "e\nbash: missing: unbound variable\n",
    );
  });

  it("routes fresh arithmetic and condition diagnostics once", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "while true; do ((1/0)); [[ $((1/0)) == x ]]; break; done 2>/errors",
    );
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(await bash.readFile("/errors")).toBe(
      "bash: arithmetic expression: division by 0\nbash: conditional expression: division by 0\n",
    );
  });

  it("preserves the caller endpoint captured before replacement", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "{ while true; do echo o; echo e >&2; break; done 2>&1 >/out; echo after; } >/parent; cat /parent /out",
    );
    expect(result).toMatchObject({
      stdout: "e\nafter\no\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.readFile("/parent")).toBe("e\nafter\n");
    expect(await bash.readFile("/out")).toBe("o\n");
  });

  it("binds definition redirections before a function returns", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "f() { echo o; echo e >&2; return 7; } >/out 2>/errors; f",
    );
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 7 });
    expect(await bash.readFile("/out")).toBe("o\n");
    expect(await bash.readFile("/errors")).toBe("e\n");
  });

  it("keeps partial-prepare diagnostics on the captured fd", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "readonly fd; while true; do :; done 2>&1 >/out {fd}>/new",
    );
    expect(result).toMatchObject({
      stdout: "bash: fd: readonly variable\n",
      stderr: "",
      exitCode: 1,
    });
    expect(await bash.readFile("/out")).toBe("");
    expect(await bash.fs.exists("/new")).toBe(false);
  });
});
