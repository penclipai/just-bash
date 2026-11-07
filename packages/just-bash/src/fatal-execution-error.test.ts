import { describe, expect, it } from "vitest";
import { rethrowFatalExecutionError } from "./fatal-execution-error.js";
import { BrokenPipeError } from "./interpreter/broken-pipe-error.js";
import { BrokenPipeError as LegacyBrokenPipeError } from "./interpreter/byte-pipe.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "./interpreter/errors.js";
import { SecurityViolationError } from "./security/defense-in-depth-box.js";
import { SecurityViolationError as DirectSecurityViolationError } from "./security/security-violation-error.js";

describe("rethrowFatalExecutionError", () => {
  it("keeps fatal error identity through the legacy exports", () => {
    expect(BrokenPipeError).toBe(LegacyBrokenPipeError);
    expect(SecurityViolationError).toBe(DirectSecurityViolationError);
    const broken = new LegacyBrokenPipeError();
    expect(() => rethrowFatalExecutionError(broken)).toThrow(broken);
  });

  it("rethrows safety failures unchanged", () => {
    const limit = new ExecutionLimitError("test", "iterations");
    const aborted = new ExecutionAbortedError();
    const violation = new SecurityViolationError("test", {
      type: "eval",
      message: "test",
      path: "globalThis.eval",
      timestamp: Date.now(),
      executionId: "test",
    });

    expect(() => rethrowFatalExecutionError(limit)).toThrow(limit);
    expect(() => rethrowFatalExecutionError(aborted)).toThrow(aborted);
    expect(() => rethrowFatalExecutionError(violation)).toThrow(violation);
  });

  it("allows ordinary command errors to be handled", () => {
    expect(() =>
      rethrowFatalExecutionError(new Error("ordinary")),
    ).not.toThrow();
  });

  it("does not suggest exclusions for defense context invariants", () => {
    const violation = new SecurityViolationError("test", {
      type: "missing_defense_context",
      message: "test",
      path: "DefenseInDepthBox.context",
      timestamp: Date.now(),
      executionId: "test",
    });

    expect(violation.message).not.toContain("excludeViolationTypes");
  });
});
