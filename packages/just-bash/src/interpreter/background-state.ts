import { beginIsolatedShellState } from "./state-transaction.js";
import type { InterpreterState } from "./types.js";
import { utf8ByteLength } from "../encoding.js";

/** Namespace-only clone. Shared open input/RW descriptions are rejected at launch. */
export function cloneBackgroundState(
  parent: InterpreterState,
): InterpreterState {
  const state = { ...parent };
  beginIsolatedShellState(state);
  state.automaTraps = new Map(
    parent.options.errtrace && parent.automaTraps?.has("ERR")
      ? [["ERR", parent.automaTraps.get("ERR")!]]
      : [],
  );
  state.automaTrapVersions = new Map();
  state.automaTrapRunning = new Set();
  state.automaTrapScriptDepth = 0;
  state.automaTrapExiting = false;
  state.automaTrapExitStatus = undefined;
  // Only immutable live capture metadata travels; pending parent writers do not.
  state.processSubstitutions = parent.processSubstitutions
    ?.filter((entry) => entry.automaCaptureAccounting)
    .map((entry) => ({ ...entry }));
  state.groupStdin = "";
  state.groupStdinSourceFd = undefined;
  state.fdInputSessions = undefined;
  state.fileDescriptors?.delete(0);
  state.inputFds?.delete(0);
  state.deviceFds?.delete(0);
  state.fdAliases?.delete(0);
  state.closedStandardFds?.delete(0);
  state.loopDepth = 0;
  state.parentHasLoopContext = false;
  state.inCondition = false;
  return state;
}

/** Count copied scalar data before allocating the child namespace. */
export function backgroundStateBytes(state: InterpreterState): number {
  let bytes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      bytes += utf8ByteLength(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    bytes += 32;
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key);
        visit(entry);
      }
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  visit(state);
  return bytes;
}
