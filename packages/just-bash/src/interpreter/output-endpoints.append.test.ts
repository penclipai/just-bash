import { describe, expect, it, vi } from "vitest";
import { Bash } from "../Bash.js";
import { ExecutionScope } from "../execution-scope.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { registerOutputFileAppender } from "../fs/output-write.js";
import { resolveLimits } from "../limits.js";
import { ExecutionLimitError } from "./errors.js";
import {
  bindOutputEndpoints,
  type OutputEndpoints,
} from "./output-endpoints.js";
import type { InterpreterContext } from "./types.js";

function fixture() {
  const fs = new InMemoryFs({ "/out": "" });
  const stat = fs.stat.bind(fs);
  const requests: number[] = [];
  registerOutputFileAppender(
    fs,
    async (path, expectedSize, content, options) => {
      requests.push(expectedSize);
      if ((await stat(path)).size !== expectedSize) return false;
      await fs.appendFile(path, content, options);
      return true;
    },
  );
  const ctx = {
    fs,
    executionScope: new ExecutionScope(resolveLimits()),
  } as unknown as InterpreterContext;
  const sink = { kind: "file" as const, path: "/out", append: false };
  const endpoints = bindOutputEndpoints(ctx, {
    stdout: sink,
    stderr: sink,
  }) as Required<OutputEndpoints>;
  return { fs, ctx, endpoints, requests };
}

describe("conditional output append", () => {
  it("appends visible bytes without a separate stat", async () => {
    const { fs, endpoints, requests } = fixture();
    const stat = vi.spyOn(fs, "stat");
    await endpoints.stdout.write("汉", "text");
    expect(await fs.readFileBuffer("/out")).toEqual(
      new Uint8Array([0xe6, 0xb1, 0x89]),
    );
    await endpoints.stdout.write("\0\xff", "bytes");
    expect(await fs.readFileBuffer("/out")).toEqual(
      new Uint8Array([0xe6, 0xb1, 0x89, 0, 255]),
    );
    expect(requests).toEqual([0, 3]);
    expect(stat).not.toHaveBeenCalled();
  });

  it("falls back to the original cursor after truncation", async () => {
    const { fs, endpoints, requests } = fixture();
    await endpoints.stdout.write("ab", "text");
    await fs.writeFile("/out", "Q");
    const stat = vi.spyOn(fs, "stat");
    await endpoints.stdout.write("Z", "text");
    expect(await fs.readFile("/out", "binary")).toBe("Q\0Z");
    expect(requests).toEqual([0, 2]);
    expect(stat).toHaveBeenCalledTimes(1);
  });

  it("preserves the successful prefix and cursor on failure", async () => {
    const { fs, endpoints } = fixture();
    await endpoints.stdout.write("ab", "text");
    registerOutputFileAppender(fs, async () => {
      throw new Error("EIO: injected append failure");
    });
    await expect(endpoints.stdout.write("lost", "text")).rejects.toThrow(
      "EIO: injected append failure",
    );
    expect(await fs.readFile("/out")).toBe("ab");
    const positions: number[] = [];
    registerOutputFileAppender(fs, async (path, expected, content, options) => {
      positions.push(expected);
      await fs.appendFile(path, content, options);
      return true;
    });
    await endpoints.stdout.write("c", "text");
    expect(positions).toEqual([2]);
    expect(await fs.readFile("/out")).toBe("abc");
  });

  it("serializes aliased writers until each append completes", async () => {
    const { fs, endpoints } = fixture();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const ready = new Promise<void>((done) => {
      started = done;
    });
    const events: string[] = [];
    registerOutputFileAppender(fs, async (path, expected, content, options) => {
      events.push(`start:${content}:${expected}`);
      if (content === "a") {
        started();
        await gate;
      }
      await fs.appendFile(path, content, options);
      events.push(`done:${content}`);
      return true;
    });
    expect(endpoints.stderr).toBe(endpoints.stdout);
    const first = endpoints.stdout.write("a", "text");
    await ready;
    const second = endpoints.stderr.write("b", "text");
    expect(await fs.readFile("/out")).toBe("");
    expect(events).toEqual(["start:a:0"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["start:a:0", "done:a", "start:b:1", "done:b"]);
    expect(await fs.readFile("/out")).toBe("ab");
  });

  it("keeps independent open positions for the same pathname", async () => {
    const { fs, ctx, endpoints, requests } = fixture();
    const other = bindOutputEndpoints(ctx, {
      stdout: { kind: "file", path: "/out", append: false },
      stderr: { kind: "discard" },
    }) as Required<OutputEndpoints>;
    await endpoints.stdout.write("a", "text");
    await other.stdout.write("B", "text");
    await endpoints.stdout.write("c", "text");
    expect(requests).toEqual([0, 0, 1]);
    expect(await fs.readFile("/out")).toBe("Bc");
  });

  it("forwards umask policy without lending capture credits", async () => {
    const { fs, requests } = fixture();
    const bash = new Bash({ fs, cwd: "/", defenseInDepth: false });
    const result = await bash.exec(
      "umask 077; { printf a; printf b; } >/private; cat <({ printf c; printf d; })",
    );
    expect(result).toMatchObject({ stdout: "cd", stderr: "", exitCode: 0 });
    expect(await fs.readFile("/private")).toBe("ab");
    expect((await fs.stat("/private")).mode & 0o777).toBe(0o600);
    expect(requests).toEqual([0, 1]);
  });

  it("does not recreate removed output while probing", async () => {
    const { fs, requests } = fixture();
    const bash = new Bash({ fs, cwd: "/", defenseInDepth: false });
    const result = await bash.exec(
      "umask 077; { printf a; rm /out; printf b; } >/out",
    );
    expect(result.exitCode).not.toBe(0);
    expect(await fs.exists("/out")).toBe(false);
    expect(requests).toEqual([0]);
  });

  it("rejects work exhaustion before another append", async () => {
    const { fs, ctx, requests } = fixture();
    ctx.executionScope = new ExecutionScope(resolveLimits({ maxWorkUnits: 1 }));
    const endpoints = bindOutputEndpoints(ctx, {
      stdout: { kind: "file", path: "/out", append: false },
      stderr: { kind: "discard" },
    }) as Required<OutputEndpoints>;
    await endpoints.stdout.write("aa", "text");
    await expect(endpoints.stdout.write("bb", "text")).rejects.toBeInstanceOf(
      ExecutionLimitError,
    );
    expect(await fs.readFile("/out")).toBe("aa");
    expect(requests).toEqual([0]);
  });
});
