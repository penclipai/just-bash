import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import type { ShellJobSnapshot } from "../types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("invocation-local background jobs", () => {
  it("runs an entire asynchronous statement and preserves state", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      'value=parent; { value=child; echo "$value"; } && echo end & child=$!; wait "$child"; echo "$value:$?"',
    );
    expect(result.stdout).toBe("child\nend\nparent:0\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("wait returns child status without replaying output", async () => {
    const chunks: string[] = [];
    const result = await new Bash().exec(
      '{ echo background; exit 7; } & p=$!; wait "$p"; echo first:$?; wait "$p"; echo again:$?; wait 999; echo unknown:$?',
      {
        onOutput: (text) => {
          chunks.push(text);
        },
      },
    );
    expect(result.stdout).toBe("background\nfirst:7\nagain:7\nunknown:127\n");
    expect(result.stderr).toBe("bash: wait: no such child process\n");
    expect(chunks.join("")).toBe(
      "background\nfirst:7\nagain:7\nbash: wait: no such child process\nunknown:127\n",
    );
  });

  it("keeps pending identities and completion output ordered", async () => {
    const a = deferred(),
      b = deferred(),
      both = deferred();
    let started = 0;
    let snapshot: ShellJobSnapshot | undefined;
    const bash = new Bash({
      customCommands: [
        defineCommand("gate", async ([name], ctx) => {
          if (++started === 2) both.resolve();
          await (name === "a" ? a.promise : b.promise);
          await ctx.writeOutput?.(`${name}\n`, "stdout");
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
        defineCommand("snapshot", async (_args, ctx) => {
          await both.promise;
          snapshot = ctx.getShellJobSnapshot?.();
          b.resolve();
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
        defineCommand("release", async () => {
          a.resolve();
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });
    const result = await bash.exec(
      'gate a & first=$!; gate b & second=$!; snapshot; wait "$second"; release; wait "$first"',
    );
    expect(snapshot?.jobs.map((job) => job.stat)).toEqual([
      "running",
      "running",
    ]);
    expect(snapshot?.jobs.map((job) => job.pid)).toEqual([2, 3]);
    expect(snapshot?.jobs.map((job) => job.ppid)).toEqual([1, 1]);
    expect(result.stdout).toBe("b\na\n");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("joins at shell end and keeps the foreground exit status", async () => {
    const gate = deferred(),
      started = deferred();
    const bash = new Bash({
      customCommands: [
        defineCommand("gate", async () => {
          started.resolve();
          await gate.promise;
          return { stdout: "joined\n", stderr: "", exitCode: 9 };
        }),
      ],
    });
    let finished = false;
    const execution = bash.exec("gate & false").then((result) => {
      finished = true;
      return result;
    });
    await started.promise;
    expect(finished).toBe(false);
    gate.resolve();
    const result = await execution;
    expect(result.stdout).toBe("joined\n");
    expect(result.exitCode).toBe(1);
  });

  it("retains redirected endpoints after a group restores them", async () => {
    const gate = deferred(),
      started = deferred();
    const bash = new Bash({
      customCommands: [
        defineCommand("gate", async () => {
          started.resolve();
          await gate.promise;
          return { stdout: "late\n", stderr: "", exitCode: 0 };
        }),
        defineCommand("release", async () => {
          await started.promise;
          gate.resolve();
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
        defineCommand("wrapped", (_args, ctx) =>
          ctx.exec!("gate &", { cwd: ctx.cwd }),
        ),
      ],
    });
    const result = await bash.exec(
      "{ wrapped; echo early; } > /captured; echo outside; release; wait; cat /captured",
    );
    expect(result.stdout).toBe("outside\nearly\nlate\n");
    expect(await bash.readFile("/captured")).toBe("early\nlate\n");
  });

  it("captures background writers before substitution EOF", async () => {
    const result = await new Bash().exec(
      'text=$(echo one; echo two &); printf "[%s]\\n" "$text"',
    );
    expect(result.stdout).toBe("[one\ntwo]\n");
    expect(result.stderr).toBe("");
  });

  it("retains pipeline writers until their capture reaches EOF", async () => {
    const result = await new Bash().exec(
      'text=$({ echo one; echo two & } | cat); printf "[%s]\\n" "$text"',
    );
    expect(result.stdout).toBe("[one\ntwo]\n");
    expect(result.stderr).toBe("");
  });

  it("captures process substitution background writers", async () => {
    const result = await new Bash().exec("cat < <(echo one; echo two &)");
    expect(result.stdout).toBe("one\ntwo\n");
    expect(result.stderr).toBe("");
  });

  it("uses EOF stdin unless the child redirects it", async () => {
    const bash = new Bash({ files: { "/input": "explicit\n" } });
    const result = await bash.exec(
      "{ cat & cat < /input & wait; } <<< inherited",
    );
    expect(result.stdout).toBe("explicit\n");
    expect(result.stderr).toBe("");
  });

  it("rejects shared extra FDs before starting job effects", async () => {
    const bash = new Bash({ files: { "/preserve": "original" } });
    const result = await bash.exec(
      "exec 3<>/preserve; echo changed > /preserve & wait",
    );
    expect(result.stderr).toBe(
      "bash: background jobs cannot inherit extra file descriptors\n",
    );
    expect(await bash.readFile("/preserve")).toBe("original");
  });
});
