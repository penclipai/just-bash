import type { ExecResult } from "../types.js";
import { ExecutionLimitError } from "./errors.js";
import { bindPipelineOutput } from "./pipeline-redirections.js";
import type { InterpreterContext } from "./types.js";

/** Arithmetic consumes substitution stdout instead of its enclosing FD1. */
export async function executeArithmeticSubstitution(
  ctx: InterpreterContext,
  command: string,
): Promise<ExecResult> {
  const savedDepth = ctx.substitutionDepth;
  const depth = savedDepth ?? 0;
  if (depth >= ctx.limits.maxSubstitutionDepth)
    throw new ExecutionLimitError(
      `Command substitution nesting limit exceeded (${ctx.limits.maxSubstitutionDepth})`,
      "substitution_depth",
    );
  ctx.substitutionDepth = depth + 1;
  const capture = ctx.output?.captureResult(ctx.substitutionDepth);
  const restoreOutput = bindPipelineOutput(ctx, false);
  try {
    const result = await ctx.execFn(command, { signal: ctx.state.signal });
    return capture?.finish(result) ?? result;
  } finally {
    capture?.close();
    restoreOutput();
    ctx.substitutionDepth = savedDepth;
  }
}
