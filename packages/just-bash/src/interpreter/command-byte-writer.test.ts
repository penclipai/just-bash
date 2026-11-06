import { describe, expect, it } from "vitest";
import { ExecutionScope } from "../execution-scope.js";
import { resolveLimits } from "../limits.js";
import { bufferByteReader } from "../utils/buffer-byte-reader.js";
import { createCommandByteIO } from "./command-byte-io.js";

describe("byte writer lifecycle", () => {
  it("admits queued writes before retaining their byte blocks", async () => {
    const scope = new ExecutionScope(resolveLimits({ maxLiveBytes: 200 }));
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const io = createCommandByteIO(
      {
        executionScope: scope,
        async writeOutput() {
          await gate;
        },
      },
      bufferByteReader(new Uint8Array()),
    );
    const accepted = io.stdout.write(new Uint8Array(100));
    expect(() => io.stdout.write(new Uint8Array(100))).toThrow();
    release();
    await accepted;
    expect(scope.remainingLiveBytes).toBe(200);
    await scope.close();
  });
  it("drains accepted writes before closing the writer", async () => {
    let start!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const io = createCommandByteIO(
      {
        async writeOutput() {
          start();
          await pending;
        },
      },
      bufferByteReader(new Uint8Array()),
    );
    const written = io.stdout.write(new Uint8Array([65]));
    await started;
    let drained = false;
    const closed = io.stdout.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await Promise.all([written, closed]);
    expect(drained).toBe(true);
    expect(() => io.stdout.write(new Uint8Array([66]))).toThrow();
  });
});
