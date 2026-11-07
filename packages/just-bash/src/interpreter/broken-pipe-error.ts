import { ExitError } from "./errors.js";

export class BrokenPipeError extends ExitError {
  readonly code = "EPIPE";
  constructor() {
    super(141);
    this.message = "Broken pipe";
  }
}
