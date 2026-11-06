import { createOutputSink } from "../output-sink.js";
import type { ExecResult } from "../types.js";
import type { OutputEndpoints } from "./output-endpoints.js";
import type { InterpreterContext } from "./types.js";

/** Host extensions retain nested stdout/stderr for their returned transforms. */
export async function executeCommandChild(
  ctx: InterpreterContext,
  capture: boolean,
  ...args: Parameters<InterpreterContext["execFn"]>
): Promise<ExecResult> {
  const inheritOutput = args[1]?.inheritOutput;
  if (inheritOutput === true || (!capture && inheritOutput !== false))
    return ctx.execFn(...args);
  const output = createOutputSink(ctx.executionScope);
  const endpoints: OutputEndpoints = {
    stdout: { stream: "stdout", write: async () => {} },
    stderr: { stream: "stderr", write: async () => {} },
  };
  const [script, options, accounted, input] = args;
  return output.finish(
    await ctx.execFn(script, options, accounted, input, endpoints, output),
  );
}
