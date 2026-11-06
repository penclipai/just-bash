import type { ExecResult } from "../types.js";
import { applyRedirections } from "./redirections.js";
import type { InterpreterContext } from "./types.js";

export type CompoundOutputPolicy = "fresh" | "relayed";

export const COMPOUND_OUTPUT_ROUTES = {
  stdout: { kind: "live-stdout" as const },
  stderr: { kind: "live-stderr" as const },
};

/** Child statements have already resolved their inherited output endpoints. */
export function routeCompoundOutput(
  ctx: InterpreterContext,
  result: ExecResult,
  policy: CompoundOutputPolicy,
  hasRedirections = true,
): Promise<ExecResult> {
  return applyRedirections(
    policy === "relayed" ? { ...ctx, outputEndpoints: undefined } : ctx,
    result,
    hasRedirections,
    COMPOUND_OUTPUT_ROUTES,
  );
}
