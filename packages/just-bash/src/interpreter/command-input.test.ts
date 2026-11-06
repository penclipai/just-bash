import { describe, expect, it } from "vitest";
import { latin1FromBytes, unsafeBytesFromLatin1 } from "../encoding.js";
import { createCommandInput } from "./command-input.js";
import { ExecutionAbortedError } from "./errors.js";

describe("shared input lifecycle", () => {
  it("cancels and drains a legacy read before closing", async () => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false;
    const input = createCommandInput(
      unsafeBytesFromLatin1(""),
      {
        remaining: "",
        async readMore(signal) {
          start();
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          await pendingRead;
          return false;
        },
      },
      undefined,
    );
    const reading = input.readStdin().catch((error: unknown) => error);
    await started;
    let closed = false;
    const closing = input.reader.cancel().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(await reading).toBeInstanceOf(ExecutionAbortedError);
    expect(await input.readStdinChunk()).toBe(null);
    expect(latin1FromBytes(await input.readStdin())).toBe("");
  });

  it("serializes byte and legacy reads on the same cursor", async () => {
    const input = createCommandInput(
      unsafeBytesFromLatin1("ABCD"),
      undefined,
      undefined,
    );
    const [first, rest] = await Promise.all([
      input.reader.read(1),
      input.readStdinChunk(),
    ]);
    expect(first).toEqual(new Uint8Array([65]));
    expect(rest && latin1FromBytes(rest)).toBe("BCD");
    expect(input.consumed).toBe(4);
    await input.reader.close();
  });
});
