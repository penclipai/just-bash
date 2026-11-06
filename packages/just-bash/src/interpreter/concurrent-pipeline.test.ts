import { assert, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("concurrent shell pipelines", () => {
  it("keeps legacy nested exec results available for transforms", async () => {
    const bash = new Bash({
      customCommands: [
        {
          name: "wrap",
          async execute(_args, ctx) {
            assert(ctx.exec);
            const child = await ctx.exec("printf child", { cwd: ctx.cwd });
            return {
              stdout: `[${child.stdout}]`,
              stderr: child.stderr,
              exitCode: child.exitCode,
            };
          },
        },
      ],
    });
    expect(await bash.exec("wrap | cat")).toMatchObject({
      stdout: "[child]",
      stderr: "",
      exitCode: 0,
    });
  });
  it("selects serial execution before available jobs run out", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let produced = 0;
    const bash = new Bash({
      executionLimits: { maxBackgroundJobs: 3 },
      customCommands: [
        {
          name: "hold",
          async execute() {
            await gate;
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
        {
          name: "produce",
          async execute() {
            produced++;
            return { stdout: "A", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec("hold & produce | cat | cat; wait", {
      onOutput(text) {
        if (text === "A") release();
      },
    });
    expect(result).toMatchObject({ stdout: "A", stderr: "", exitCode: 0 });
    expect(produced).toBe(1);
  });
  it("isolates process substitution descriptor namespaces", async () => {
    const result = await new Bash().exec("cat <(printf A) | cat - <(printf B)");
    expect(result).toMatchObject({ stdout: "AB", stderr: "", exitCode: 0 });
  });
  it("exposes advanced inherited descriptions to commands", async () => {
    const bash = new Bash({
      files: { "/input": "A\nB\n" },
      customCommands: [
        {
          name: "fdbytes",
          async execute(_args, ctx) {
            return {
              stdout: ctx.fileDescriptors?.get(3) ?? "missing",
              stderr: "",
              exitCode: 0,
            };
          },
        },
      ],
    });
    expect(
      await bash.exec("exec 3</input; (read -u3 a); fdbytes"),
    ).toMatchObject({ stdout: "B\n", stderr: "", exitCode: 0 });
  });
  it("pipes definition-time diagnostics through pipe ampersand", async () => {
    const result = await new Bash().exec(
      "set -o posix; function eval() { :; } |& cat",
    );
    expect(result.stdout).toContain("is a special builtin");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
  it("excludes foreground siblings from lastpipe wait", async () => {
    const result = await new Bash().exec(
      "shopt -s lastpipe; printf '%200000s' x | wait; echo ${PIPESTATUS[*]}; echo done",
    );
    expect(result).toMatchObject({
      stdout: "141 0\ndone\n",
      stderr: "",
      exitCode: 0,
    });
  });
  it("starts readers before producers finish", async () => {
    let readerStarted = () => {};
    const ready = new Promise<void>((resolve) => {
      readerStarted = resolve;
    });
    const bash = new Bash({
      customCommands: [
        {
          name: "produce",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            await ready;
            await ctx.byteIO.stdout.write(new TextEncoder().encode("ready\n"));
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
        {
          name: "consume",
          streamingStdin: true,
          async execute(_args, ctx) {
            readerStarted();
            assert(ctx.byteIO);
            const bytes = await ctx.byteIO.stdin.read();
            assert(bytes);
            await ctx.byteIO.stdout.write(bytes);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    expect(await bash.exec("produce | consume")).toMatchObject({
      stdout: "ready\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("closes inherited writers after background jobs finish", async () => {
    const result = await new Bash().exec(
      "{ printf x & wait; } | cat; { printf y & } | cat",
    );
    expect(result).toMatchObject({ stdout: "xy", stderr: "", exitCode: 0 });
  });

  it("inherits recursive command redirections before effects", async () => {
    const bash = new Bash();
    const result = await bash.exec("bash -c 'echo file' >/out | cat; cat /out");
    expect(result).toMatchObject({ stdout: "file\n", stderr: "", exitCode: 0 });
  });

  it("shares offsets with subshells and inherited descriptors", async () => {
    const bash = new Bash({ files: { "/input": "A\nB\nC\n" } });
    const result = await bash.exec(
      "exec 3</input; (read -u3 a; echo $a); read -u3 b; echo $b; read -u3 c | cat; read -u3 d; echo ${d:-end}",
    );
    expect(result).toMatchObject({
      stdout: "A\nB\nend\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("returns broken pipe status without cancelling the shell", async () => {
    const bash = new Bash({
      customCommands: [
        {
          name: "produce",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            await ctx.writeOutput?.("producer\n", "stderr");
            for (let i = 0; i < 6; i++)
              await ctx.byteIO.stdout.write(new Uint8Array([65 + i]));
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
        {
          name: "take",
          streamingStdin: true,
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            const bytes = await ctx.byteIO.stdin.read(1);
            assert(bytes);
            await ctx.byteIO.stdout.write(bytes);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec(
      "produce | take; echo :${PIPESTATUS[*]}; echo alive",
    );
    expect(result).toMatchObject({
      stdout: "A:141 0\nalive\n",
      stderr: "producer\n",
      exitCode: 0,
    });
  });

  it("cancels and drains the whole blocked pipeline", async () => {
    const controller = new AbortController();
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let drained = false;
    const bash = new Bash({
      customCommands: [
        {
          name: "block",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            started();
            try {
              await ctx.byteIO.stdin.read();
            } finally {
              drained = true;
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const pending = bash.exec("block | cat", { signal: controller.signal });
    await ready;
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(124);
    expect(drained).toBe(true);
  });

  it("keeps segment failures local and preserves pipe status", async () => {
    const result = await new Bash().exec(
      "echo ${#x:1:3} | cat; echo ${PIPESTATUS[@]}; set -o pipefail; false | true; echo $?; shopt -s lastpipe; printf z | read answer; echo $answer",
    );
    expect(result.stdout).toBe("1 0\n1\nz\n");
    expect(result.stderr).toContain("bad substitution");
    expect(result.exitCode).toBe(0);
  });
});
