import type { ExecResult } from "./types.js";

const presented = new WeakSet<object>();

/** Private provenance: these streams already passed the presentation decoder. */
export function markPresentedOutput<T extends ExecResult>(result: T): T {
  presented.add(result);
  return result;
}

export function isPresentedOutput(result: ExecResult): boolean {
  return presented.has(result);
}
