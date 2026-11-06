import { describe, expect, it } from "vitest";
import { ExecutionScope } from "../execution-scope.js";
import { resolveLimits } from "../limits.js";
import { BrokenPipeError, createBytePipe } from "./byte-pipe.js";
import { ExecutionAbortedError, ExecutionLimitError } from "./errors.js";

describe("bounded byte pipes", () => {
  it("retains at most two blocks including a borrowed block", async () => {
    const scope = new ExecutionScope(resolveLimits());
    const pipe = createBytePipe(scope, 100);
    const writer = pipe.writer();
    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    let accepted = false;
    const third = writer.write(new Uint8Array([3])).then(() => {
      accepted = true;
    });
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(await pipe.reader.read()).toEqual(new Uint8Array([1]));
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(await pipe.reader.read()).toEqual(new Uint8Array([2]));
    await third;
    expect(accepted).toBe(true);
    await writer.close();
    expect(await pipe.reader.read()).toEqual(new Uint8Array([3]));
    expect(await pipe.reader.read()).toBe(null);
    expect(scope.outputBytesUsed).toBe(0);
    await scope.close();
  });

  it("waits for every writer before permanent EOF", async () => {
    const scope = new ExecutionScope(resolveLimits());
    const pipe = createBytePipe(scope, 100);
    const parent = pipe.writer(),
      child = pipe.writer();
    await parent.close();
    let ended = false;
    const input = pipe.reader.read().then((bytes) => {
      ended = true;
      return bytes;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    await child.write(new Uint8Array([1]));
    expect(await input).toEqual(new Uint8Array([1]));
    await child.close();
    expect(await pipe.reader.read()).toBe(null);
    await scope.close();
  });

  it("treats a reader's early close as an ordinary broken pipe", async () => {
    const scope = new ExecutionScope(resolveLimits());
    const pipe = createBytePipe(scope, 100);
    const writer = pipe.writer();
    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    const blocked = writer.write(new Uint8Array([3]));
    const failed = expect(blocked).rejects.toBeInstanceOf(BrokenPipeError);
    await pipe.reader.close();
    await failed;
    expect(scope.failure).toBeUndefined();
    expect(scope.outputBytesUsed).toBe(0);
    await writer.close();
    await scope.close();
  });

  it("preserves the first failure while draining blocked writes", async () => {
    const scope = new ExecutionScope(resolveLimits());
    const pipe = createBytePipe(scope, 100);
    const writer = pipe.writer();
    await writer.write(new Uint8Array([1]));
    await writer.write(new Uint8Array([2]));
    const blocked = writer.write(new Uint8Array([3]));
    const reason = new ExecutionLimitError("fixture", "iterations");
    const failed = expect(blocked).rejects.toBe(reason);
    await pipe.cancel(reason);
    await failed;
    await expect(pipe.reader.read()).rejects.toBe(reason);
    await writer.close();
    await scope.close();
  });

  it("wakes unsignalled I/O on scope and job cancellation", async () => {
    for (const source of ["scope", "jobs"]) {
      const controller = new AbortController();
      const scope = new ExecutionScope(resolveLimits(), controller.signal);
      const full = createBytePipe(scope, 100);
      const empty = createBytePipe(scope, 100);
      const writer = full.writer();
      const emptyWriter = empty.writer();
      await writer.write(Uint8Array.of(1));
      await writer.write(Uint8Array.of(2));
      const before = scope.remainingLiveBytes;
      const writing = writer
        .write(Uint8Array.of(3))
        .catch((error: unknown) => error);
      const reading = empty.reader.read().catch((error: unknown) => error);
      await Promise.resolve();
      expect(scope.remainingLiveBytes).toBeLessThan(before);
      const reason = new ExecutionLimitError("first job failure", "iterations");
      if (source === "scope") controller.abort();
      else scope.shellJobs.cancel(reason);
      const first = await writing;
      if (source === "scope")
        expect(first).toBeInstanceOf(ExecutionAbortedError);
      else expect(first).toBe(reason);
      expect(await reading).toBe(first);
      await Promise.all([full.cancel(first), empty.cancel(first)]);
      expect(scope.remainingLiveBytes).toBe(resolveLimits().maxLiveBytes);
      await Promise.all([writer.close(), emptyWriter.close()]);
      await scope.close();
    }
  });
});
