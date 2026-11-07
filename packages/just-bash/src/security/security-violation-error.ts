import { getBlockedGlobalViolationTypes } from "./blocked-globals.js";
import type { SecurityViolation } from "./types.js";
import { formatViolationErrorMessage } from "./violation-error-message.js";

/** The shared error identity does not initialize the defense runtime. */
export class SecurityViolationError extends Error {
  constructor(
    message: string,
    public readonly violation: SecurityViolation,
  ) {
    super(
      formatViolationErrorMessage(
        message,
        violation.type,
        violation.type === "error_prepare_stack_trace" ||
          getBlockedGlobalViolationTypes().has(violation.type),
      ),
    );
    this.name = "SecurityViolationError";
  }
}
