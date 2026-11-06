import { describe, expect, it } from "vitest";
import { ExecutionScope } from "../execution-scope.js";
import { resolveLimits } from "../limits.js";
import { createBytePipe } from "./byte-pipe.js";
import { closeLiveInput, createLiveInput } from "./live-input.js";

class TrackedScope extends ExecutionScope {
  active = 0;
  override registerCleanup(cleanup: () => void | Promise<void>): () => void {
    this.active++;
    const unregister = super.registerCleanup(cleanup);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.active--;
        unregister();
      }
    };
  }
}

describe("live pipe cleanup lifetimes", () => {
  it("releases completed channels during repeated pipelines", async () => {
    const scope = new TrackedScope(resolveLimits());
    for (let count = 0; count < 3; count++) {
      const pipe = createBytePipe(scope, 100);
      const writer = pipe.writer();
      const input = createLiveInput(
        { readChunk: (signal) => pipe.reader.read(undefined, signal) },
        scope,
        undefined,
        100,
      );
      await writer.close();
      expect(await input.readMore?.()).toBe(false);
      expect(scope.active).toBe(0);
      await closeLiveInput(input);
    }
    await scope.close();
  });

  it("drains and unregisters a live input on early close", async () => {
    const scope = new TrackedScope(resolveLimits());
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const input = createLiveInput(
      {
        readChunk: (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new Error("closed")),
              { once: true },
            );
            started();
          }),
      },
      scope,
      undefined,
      100,
    );
    const pending = input.readMore?.().catch(() => false);
    await ready;
    await closeLiveInput(input);
    expect(await pending).toBe(false);
    expect(scope.active).toBe(0);
    expect(await input.readMore?.()).toBe(false);
    await scope.close();
  });
});
