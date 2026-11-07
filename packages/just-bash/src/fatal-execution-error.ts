import { BrokenPipeError } from "./interpreter/broken-pipe-error.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "./interpreter/errors.js";
import { SecurityViolationError } from "./security/security-violation-error.js";

/**
 * Rethrow errors that command-level recovery must never turn into ordinary
 * command failures. Call this first in broad catch blocks.
 */
export function rethrowFatalExecutionError(error: unknown): void {
  if (
    error instanceof ExecutionLimitError ||
    error instanceof ExecutionAbortedError ||
    error instanceof BrokenPipeError ||
    error instanceof SecurityViolationError
  ) {
    throw error;
  }
}
