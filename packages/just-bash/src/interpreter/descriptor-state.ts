import {
  releaseDescription,
  retainDescription,
} from "./description-lifetime.js";
import { cloneFdAliases, shareFdDescriptions } from "./fd-table.js";
import type { InterpreterContext, InterpreterState } from "./types.js";

export function cloneOwnedDescriptors(state: InterpreterState): void {
  // These read-only descriptor accessors inspect state, not host capabilities.
  shareFdDescriptions({ state } as InterpreterContext);
  state.fileDescriptors = new Map(state.fileDescriptors);
  state.inputFds = new Set(state.inputFds);
  state.deviceFds = new Set(state.deviceFds);
  state.fdAliases = cloneFdAliases(state.fdAliases);
  state.fdInputSessions = new Map(state.fdInputSessions);
  state.fdOutputEndpoints = new Map(state.fdOutputEndpoints);
  state.closedStandardFds = new Set(state.closedStandardFds);
  for (const source of state.fdInputSessions.values())
    retainDescription(source);
  for (const sink of state.fdOutputEndpoints.values()) retainDescription(sink);
}

export function releaseOwnedDescriptors(state: InterpreterState): void {
  for (const source of state.fdInputSessions?.values() ?? [])
    releaseDescription(source);
  for (const sink of state.fdOutputEndpoints?.values() ?? [])
    releaseDescription(sink);
  state.fdInputSessions?.clear();
  state.fdOutputEndpoints?.clear();
}
