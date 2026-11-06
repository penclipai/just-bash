import { assert, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { ByteWriter } from "../byte-io.js";

describe("command byte descriptions", () => {
  it("retains buffered head's unconsumed input tail", async () => {
    const file = await new Bash({ files: { "/input": "a\nb\n" } }).exec(
      "{ head -n1; cat; } </input",
    );
    expect(file).toMatchObject({ stdout: "a\nb\n", stderr: "", exitCode: 0 });
    let reads = 0;
    const live = await new Bash().exec("head -c1; cat", {
      stdinSource: {
        async readChunk() {
          return reads++ === 0 ? new TextEncoder().encode("ABCD") : null;
        },
      },
    });
    expect(live).toMatchObject({ stdout: "ABCD", stderr: "", exitCode: 0 });
  });
  it("leaves the unread descriptor tail for the next command", async () => {
    const bash = new Bash({
      files: { "/input": "ABCD" },
      customCommands: [
        {
          name: "peek",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            const chunk = await ctx.byteIO.stdin.read(1);
            assert(chunk);
            await ctx.byteIO.stdout.write(chunk);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec("{ peek; cat; } </input");
    expect(result).toMatchObject({ stdout: "ABCD", stderr: "", exitCode: 0 });
  });

  it("shares byte and legacy reads without replay", async () => {
    const bash = new Bash({
      customCommands: [
        {
          name: "mixed",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            const byte = await ctx.byteIO.stdin.read(1);
            assert(byte);
            await ctx.byteIO.stdout.write(byte);
            assert(ctx.writeOutput);
            assert(ctx.readStdin);
            await ctx.writeOutput(
              (await ctx.readStdin()) as unknown as string,
              "stdout",
              "bytes",
            );
            expect(await ctx.byteIO.stdin.read()).toBe(null);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec("printf ABCD | mixed");
    expect(result).toMatchObject({ stdout: "ABCD", stderr: "", exitCode: 0 });
  });

  it("preserves a live input tail after a partial byte read", async () => {
    let reads = 0;
    const bash = new Bash({
      customCommands: [
        {
          name: "peek",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            const byte = await ctx.byteIO.stdin.read(1);
            assert(byte);
            await ctx.byteIO.stdout.write(byte);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec("peek; cat", {
      stdinSource: {
        async readChunk() {
          return reads++ === 0 ? new TextEncoder().encode("ABCD") : null;
        },
      },
    });
    expect(result).toMatchObject({ stdout: "ABCD", stderr: "", exitCode: 0 });
  });

  it("revokes retained byte writers after command completion", async () => {
    let late: ByteWriter | undefined;
    const bash = new Bash({
      customCommands: [
        {
          name: "retain",
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            late = ctx.byteIO.stdout;
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    expect((await bash.exec("retain")).exitCode).toBe(0);
    assert(late);
    const retained = late;
    expect(() => retained.write(new Uint8Array([65]))).toThrow();
  });

  it("cancels an outstanding input read before close returns", async () => {
    let cancelled = false;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const bash = new Bash({
      customCommands: [
        {
          name: "closeinput",
          streamingStdin: true,
          async execute(_args, ctx) {
            assert(ctx.byteIO);
            const pending = ctx.byteIO.stdin.read().catch(() => null);
            await started;
            await ctx.byteIO.stdin.cancel();
            expect(await pending).toBe(null);
            expect(cancelled).toBe(true);
            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      ],
    });
    const result = await bash.exec("closeinput", {
      stdinSource: {
        readChunk(signal) {
          start();
          return new Promise<null>((resolve) =>
            signal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve(null);
              },
              { once: true },
            ),
          );
        },
      },
    });
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });
});
