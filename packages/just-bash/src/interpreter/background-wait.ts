import type { InterpreterContext } from "./types.js";
import type { ExecResult } from "../types.js";

export async function waitForShellJobs(
  ctx: InterpreterContext,
  args: string[],
): Promise<ExecResult> {
  if (
    args.some(
      (arg) => !/^[0-9]+$/.test(arg) || !Number.isSafeInteger(Number(arg)),
    )
  )
    return {
      stdout: "",
      stderr: "bash: wait: only decimal process IDs are supported\n",
      exitCode: 2,
    };
  const exitCode = await ctx.executionScope.shellJobs.wait(
    ctx.state.bashPid,
    args.length ? args.map(Number) : undefined,
  );
  return {
    stdout: "",
    stderr: exitCode === 127 ? "bash: wait: no such child process\n" : "",
    exitCode,
  };
}
