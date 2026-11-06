import { outputSegments } from "../execution-output.js";
import type { ExecResult } from "../types.js";
import { routeCompoundOutput } from "./compound-output.js";
import {
  bindOutputEndpoints,
  type OutputEndpoints,
} from "./output-endpoints.js";
import {
  createRedirectionTransaction,
  SIMPLE_REDIRECTION_POLICY,
} from "./redirections.js";
import type { InterpreterContext } from "./types.js";

/** No redirects are opened; inherit the existing open descriptions and cursors. */
export async function captureProcessWriterEndpoints(
  ctx: InterpreterContext,
): Promise<OutputEndpoints> {
  const transaction = createRedirectionTransaction(
    ctx,
    [],
    SIMPLE_REDIRECTION_POLICY,
  );
  try {
    const prepared = await transaction.prepare();
    return bindOutputEndpoints(ctx, prepared.outputRoutes);
  } finally {
    transaction.finish();
  }
}

/** Captured stdout is fresh; body stderr already resolved its own endpoint. */
export async function routeProcessWriterOutput(
  ctx: InterpreterContext,
  result: ExecResult,
  endpoints: OutputEndpoints,
): Promise<ExecResult> {
  if (!result.stdout) return result;
  const routed = await routeCompoundOutput(
    { ...ctx, outputEndpoints: endpoints },
    {
      stdout: result.stdout,
      stderr: "",
      exitCode: 0,
      stdoutKind: "bytes",
      internalOutputSegments: [["stdout", result.stdout, "bytes"]],
      internalOutputAccounting: {
        stdout: result.internalOutputAccounting?.stdout ?? 0,
        stderr: 0,
      },
    },
    "fresh",
  );
  return {
    ...routed,
    stderr: routed.stderr + result.stderr,
    internalOutputSegments: [
      ...outputSegments(routed),
      ...outputSegments(result).filter(([stream]) => stream === "stderr"),
    ],
    internalOutputAccounting: {
      stdout: routed.internalOutputAccounting?.stdout ?? 0,
      stderr:
        (routed.internalOutputAccounting?.stderr ?? 0) +
        (result.internalOutputAccounting?.stderr ?? 0),
    },
  };
}
