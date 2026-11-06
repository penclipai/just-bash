import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ExecutionLimitError } from "./errors.js";

describe("live stream descriptor identity", () => {
  it("retains stderr across nested redirection", async () => {
    const observed: string[] = [];
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "exec 3>&2; { printf saved >&3; printf hidden >&2; } 2>/errors; printf after >&3",
      {
        onOutput: (text) => {
          observed.push(text);
        },
      },
    );
    expect(result).toMatchObject({
      stdout: "",
      stderr: "savedafter",
      exitCode: 0,
    });
    expect(await bash.readFile("/errors")).toBe("hidden");
    expect(observed.join("")).toBe("savedafter");
  });

  it("escapes a later command substitution", async () => {
    const observed: string[] = [];
    const result = await new Bash().exec(
      'exec 3>&1; value=$(printf escaped >&3; printf inside); printf "[%s]" "$value"',
      {
        onOutput: (text) => {
          observed.push(text);
        },
      },
    );
    expect(result).toMatchObject({
      stdout: "escaped[inside]",
      stderr: "",
      exitCode: 0,
    });
    expect(observed.join("")).toBe("escaped[inside]");
  });

  it("retains a pipeline collector after a nested redirect", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "{ exec 3>&1; { printf piped >&3; printf file; } >/out; } | cat",
    );
    expect(result).toMatchObject({ stdout: "piped", stderr: "", exitCode: 0 });
    expect(await bash.readFile("/out")).toBe("file");
  });

  it("shares the destination through dup and close", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "exec 3>&2; exec 4>&3; exec 3>&-; { printf retained >&4; } 2>/errors",
    );
    expect(result).toMatchObject({
      stdout: "",
      stderr: "retained",
      exitCode: 0,
    });
    expect(await bash.readFile("/errors")).toBe("");
  });

  it("retains the destination in a background child", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await bash.exec(
      "exec 3>&2; { printf child >&3 & wait; } 2>/errors",
    );
    expect(result).toMatchObject({ stdout: "", stderr: "child", exitCode: 0 });
    expect(await bash.readFile("/errors")).toBe("");
  });

  it("decodes captured byte output exactly once", async () => {
    const result = await new Bash().exec(
      "exec 3>&1; printf '\\303\\203\\302\\251' >&3",
    );
    expect(result).toMatchObject({
      stdout: "Ã©",
      stderr: "",
      output: "Ã©",
      exitCode: 0,
    });
  });

  it("retains a published alias prefix on resource failure", async () => {
    const result = await new Bash({
      executionLimits: { maxCommandCount: 4 },
    }).exec("exec 3>&1; printf prefix >&3; while true; do :; done");
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toBe("prefix");
    expect(result.output).toContain("prefix");
  });

  it("merges alias output with an unpublished failure tail", async () => {
    const bash = new Bash({
      customCommands: [
        {
          name: "failtail",
          async execute() {
            throw new ExecutionLimitError("fixture", "iterations", "tail");
          },
        },
      ],
    });
    const result = await bash.exec(
      "printf same; exec 3>&1; printf same >&3; printf after; failtail | cat",
    );
    expect(result.exitCode).toBe(126);
    expect(result.stdout).toBe("samesameaftertail");
    expect(result.output).toContain("samesameafter");
    expect(result.output).not.toContain("tail");
  });
});
