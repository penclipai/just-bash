import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

function input() {
  const queued: Array<Uint8Array | null> = [];
  let pending: ((chunk: Uint8Array | null) => void) | undefined;
  return {
    readChunk(signal?: AbortSignal) {
      if (queued.length) return Promise.resolve(queued.shift() ?? null);
      return new Promise<Uint8Array | null>((resolve, reject) => {
        const deliver = (chunk: Uint8Array | null) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(chunk);
        };
        const onAbort = () => {
          if (pending === deliver) pending = undefined;
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("stdin cancelled"));
        };
        pending = deliver;
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
    write(chunk: Uint8Array | null) {
      if (pending) {
        const resolve = pending;
        pending = undefined;
        resolve(chunk);
      } else queued.push(chunk);
    },
  };
}
const text = (value: string) => new TextEncoder().encode(value);

describe("Automa child process stream capabilities", () => {
  it("cat emits raw bytes before stdin closes", async () => {
    const source = input();
    const seen: Array<[string, string, string]> = [];
    const shell = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("child", async (_args, ctx) => {
          source.write(Uint8Array.of(0, 255));
          const result = await ctx.exec?.(
            "env timeout 2 bash -c 'command cat'",
            {
              cwd: ctx.cwd,
              stdinSource: source,
              onOutputBytes(bytes, stream, kind) {
                seen.push([bytes, stream, kind]);
                source.write(null);
              },
            },
          );
          return {
            stdout: "done\n",
            stderr: "",
            exitCode: result?.exitCode ?? 1,
          };
        }),
      ],
    });
    const terminal: string[] = [];
    const result = await shell.exec("child", {
      onOutput: (chunk) => {
        terminal.push(chunk);
      },
    });
    expect(seen).toEqual([["\0\xff", "stdout", "bytes"]]);
    expect(result.stdout).toBe("done\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(terminal).toEqual(["done\n"]);
  });

  it("read waits per line and shares descriptor positions", async () => {
    const source = input();
    source.write(text("first\n"));
    const seen: string[] = [];
    const shell = new Bash({ defenseInDepth: false });
    const result = await shell.exec(
      'exec 3<&0; builtin read -u 3 a; printf "%s\\n" "$a"; read b; printf "%s\\n" "$b"',
      {
        stdinSource: source,
        onOutputBytes(chunk) {
          seen.push(chunk);
          if (chunk === "first\n") source.write(text("second\n"));
        },
      },
    );
    expect(seen).toEqual(["first\n", "second\n"]);
    expect(result.stdout).toBe("first\nsecond\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("concurrent children keep output sinks separate", async () => {
    const seen: string[][] = [[], []];
    const shell = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("children", async (_args, ctx) => {
          await Promise.all(
            ["A", "B"].map((value, index) =>
              ctx.exec?.(`bash -c 'printf ${value}; printf err >&2'`, {
                cwd: ctx.cwd,
                onOutputBytes: (chunk, stream) => {
                  seen[index].push(`${stream}:${chunk}`);
                },
              }),
            ),
          );
          return { stdout: "parent", stderr: "", exitCode: 0 };
        }),
      ],
    });
    const result = await shell.exec("children");
    expect(seen).toEqual([
      ["stdout:A", "stderr:err"],
      ["stdout:B", "stderr:err"],
    ]);
    expect(result.stdout).toBe("parent");
    expect(result.stderr).toBe("");
  });

  it("bulk stdin readers wait for EOF and preserve bytes", async () => {
    const source = input();
    source.write(text("one\n"));
    source.write(text("two\n"));
    source.write(null);
    const result = await new Bash({ defenseInDepth: false }).exec("wc -l", {
      stdinSource: source,
    });
    expect(result.stdout).toBe("2\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("redirections isolate streams from the live callback", async () => {
    const source = input();
    source.write(text("file\n"));
    source.write(null);
    const seen: string[] = [];
    const shell = new Bash({ defenseInDepth: false });
    const result = await shell.exec(
      'cat >saved; v=$(printf hidden); printf "%s" "$v" >&2',
      {
        stdinSource: source,
        onOutputBytes: (chunk, stream) => {
          seen.push(`${stream}:${chunk}`);
        },
      },
    );
    expect(seen).toEqual(["stderr:hidden"]);
    expect(await shell.fs.readFile("/home/user/saved")).toBe("file\n");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("hidden");
  });

  it("an aborted pending read settles without EOF", async () => {
    const stop = new AbortController();
    const source = input();
    const shell = new Bash({ defenseInDepth: false });
    const result = shell.exec("read value", {
      signal: stop.signal,
      stdinSource: {
        readChunk: () => {
          stop.abort();
          return source.readChunk();
        },
      },
    });
    expect((await result).exitCode).toBe(124);
  });

  it("read timeout preserves partial data and the open source", async () => {
    const source = input();
    source.write(text("partial"));
    const result = await new Bash({ defenseInDepth: false }).exec(
      'read -t .01 a; printf "%s:%s\\n" "$?" "$a"; read b; printf "%s\\n" "$b"',
      {
        stdinSource: source,
        onOutputBytes(chunk) {
          if (chunk === "142:partial\n") source.write(text("next\n"));
        },
      },
    );
    expect(result.stdout).toBe("142:partial\nnext\n");
    expect(result.exitCode).toBe(0);
  });

  it("mapfile stops at its line limit before EOF", async () => {
    const source = input();
    source.write(text("one\ntwo\n"));
    const result = await new Bash({ defenseInDepth: false }).exec(
      'mapfile -t -n 1 a; read b; printf "%s:%s" "${a[0]}" "$b"',
      { stdinSource: source },
    );
    expect(result.stdout).toBe("one:two");
    expect(result.exitCode).toBe(0);
  });

  it("cancelled readers leave stdin open for later commands", async () => {
    const source = input();
    const shell = new Bash({
      defenseInDepth: false,
      customCommands: [
        defineCommand("reader", async (_args, ctx) => {
          const controller = new AbortController();
          const read = ctx.readStdinChunk?.(controller.signal);
          controller.abort();
          await expect(read).rejects.toThrow();
          source.write(text("later\n"));
          source.write(null);
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });
    const result = await shell.exec("reader; cat", { stdinSource: source });
    expect(result.stdout).toBe("later\n");
    expect(result.exitCode).toBe(0);
  });

  it("live chunks respect the shared input budget", async () => {
    const source = input();
    source.write(Uint8Array.of(1, 2, 3));
    const result = await new Bash({
      defenseInDepth: false,
      executionLimits: { maxInputBytes: 2 },
    }).exec("cat", { stdinSource: source });
    expect(result.exitCode).toBe(126);
    expect(result.executionFailure?.kind).toBe("resource-limit");
  });

  it("execution deadlines cancel pending source waiters", async () => {
    const source = input();
    let sourceSignal: AbortSignal | undefined;
    const result = await new Bash({
      defenseInDepth: false,
      executionLimits: { maxExecutionTimeMs: 100 },
    }).exec("read value", {
      stdinSource: {
        readChunk(signal) {
          sourceSignal = signal;
          return source.readChunk(signal);
        },
      },
    });
    expect(result.exitCode).toBe(124);
    expect(sourceSignal?.aborted).toBe(true);
  });
});
