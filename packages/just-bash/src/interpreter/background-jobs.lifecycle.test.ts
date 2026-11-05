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

describe("background job ownership and revocation", () => {
  it("rejects the 33rd launch before its command effects", async () => {
    let starts = 0;
    const bash = new Bash({
      customCommands: [
        defineCommand("gate", async (_args, ctx) => {
          starts++;
          await new Promise<void>((resolve) => {
            ctx.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
            if (ctx.signal?.aborted) resolve();
          });
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });
    const result = await bash.exec("for i in $(seq 1 33); do gate & done");
    expect(starts).toBe(32);
    expect(result.exitCode).toBe(126);
    expect(result.executionFailure?.kind).toBe("resource-limit");
    expect(result.stderr).toContain("background job limit exceeded (32)");
  });

  it("revokes late writes after Stop and drains the task", async () => {
    const started = deferred(),
      release = deferred(),
      observed = deferred();
    const controller = new AbortController();
    let lateError: unknown;
    const bash = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("late", async (_args, ctx) => {
          started.resolve();
          await release.promise;
          try {
            await ctx.fs.writeFile("/late", "forbidden");
          } catch (error) {
            lateError = error;
          }
          observed.resolve();
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });
    const pending = bash.exec("late &", { signal: controller.signal });
    await started.promise;
    controller.abort();
    const result = await pending;
    expect(result.exitCode).toBe(124);
    release.resolve();
    await observed.promise;
    expect(lateError).toBeInstanceOf(Error);
    await expect(bash.readFile("/late")).rejects.toThrow();
  });

  it("cancels sibling work after a child resource failure", async () => {
    const started = deferred();
    const bash = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("hold", async (_args, ctx) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            ctx.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
            if (ctx.signal?.aborted) resolve();
          });
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
        defineCommand("exhaust", async (_args, ctx) => {
          await started.promise;
          ctx.executionScope!.reserveBytes(2 ** 31, "background regression");
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });
    const result = await bash.exec("hold & exhaust & hold");
    expect(result.exitCode).toBe(126);
    expect(result.executionFailure?.kind).toBe("resource-limit");
  });

  it("joins background work when the foreground exits", async () => {
    const result = await new Bash().exec("echo joined & exit 5");
    expect(result.stdout).toBe("joined\n");
    expect(result.exitCode).toBe(5);
  });

  it("allocates unique PIDs and binds nested commands to caller", async () => {
    const snapshots: ShellJobSnapshot[] = [];
    const identities: unknown[] = [];
    const bash = new Bash({
      customCommands: [
        defineCommand("snapshot", async (_args, ctx) => {
          snapshots.push(ctx.getShellJobSnapshot!());
          identities.push(ctx.fsIdentity);
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
        defineCommand("wrapped", (_args, ctx) =>
          ctx.exec!("snapshot", { cwd: ctx.cwd }),
        ),
      ],
    });
    const result = await bash.exec(
      'x=$(echo "$BASHPID"); snapshot; { wrapped; bash -c "snapshot"; } & p=$!; wait "$p"; printf "%s:%s\\n" "$x" "$p"',
    );
    expect(result.stdout).toBe("2:3\n");
    expect(snapshots.map((snapshot) => snapshot.shell.pid)).toEqual([1, 3, 4]);
    expect(snapshots.map((snapshot) => snapshot.shell.ppid)).toEqual([0, 1, 3]);
    expect(snapshots[1].jobs).toEqual([]);
    expect(identities.every((identity) => identity === identities[0])).toBe(
      true,
    );
  });

  it("binds recursive wrappers to the child namespace", async () => {
    const bash = new Bash({
      customCommands: [
        defineCommand("wrapped", (_args, ctx) =>
          ctx.exec!('f; echo "$value"', { cwd: ctx.cwd }),
        ),
      ],
    });
    const result = await bash.exec(
      'value=parent; { value=child; f() { echo function; }; wrapped; } & wait; echo "$value"',
    );
    expect(result.stdout).toBe("function\nchild\nparent\n");
    expect(result.stderr).toBe("");
  });

  it("background clone does not inherit its own new $!", async () => {
    const result = await new Bash().exec(
      'printf "%s:%s:%s\\n" "$$" "$BASHPID" "$!" & wait',
    );
    expect(result.stdout).toBe("1:2:0\n");
  });

  it("keeps the parent EXIT trap in the parent shell", async () => {
    const result = await new Bash().exec(
      'trap "echo EXIT" EXIT; { echo child; } & wait',
    );
    expect(result.stdout).toBe("child\nEXIT\n");
    expect(result.stderr).toBe("");
  });

  it("wait all consumes done records and rejects foreign IDs", async () => {
    const result = await new Bash().exec(
      '{ exit 7; } & p=$!; bash -c "wait $p"; echo foreign:$?; wait; echo all:$?; wait -n',
    );
    expect(result.stdout).toBe("foreign:127\nall:0\n");
    expect(result.stderr).toBe(
      "bash: wait: no such child process\nbash: wait: only decimal process IDs are supported\n",
    );
    expect(result.exitCode).toBe(2);
  });
});
