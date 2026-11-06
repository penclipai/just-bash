import { describe, expect, it } from "vitest";
import { ExecutionScope } from "../execution-scope.js";
import { resolveLimits } from "../limits.js";
import { ExecutionAbortedError, ExecutionLimitError } from "./errors.js";
import type { InterpreterState } from "./types.js";

describe("background cancellation causes", () => {
  it.each([
    false,
    true,
  ])("keeps the first cause when Stop is first: %s", async (stopFirst) => {
    const scope = new ExecutionScope(resolveLimits());
    const jobs = scope.shellJobs;
    const owner = { nextVirtualPid: 2, bashPid: 1 } as InterpreterState;
    const limit = new ExecutionLimitError("child recursion limit", "recursion");
    const stop = new ExecutionAbortedError("", "user stopped\n");
    const cancelled = new Promise<void>((resolve) => {
      jobs.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    jobs.launch(owner, "earlier sibling", 0, () => async () => {
      await cancelled;
      jobs.cancel(stop);
      throw new ExecutionAbortedError();
    });
    jobs.launch(owner, "later child", 0, () => async () => {
      if (stopFirst) jobs.cancel(stop);
      throw limit;
    });
    try {
      await expect(jobs.joinAll()).rejects.toBe(stopFirst ? stop : limit);
    } finally {
      jobs.close();
    }
  });
});
