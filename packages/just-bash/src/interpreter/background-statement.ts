import type { StatementNode } from "../ast/types.js";
import { serialize } from "../transform/serialize.js";
import type { ExecResult } from "../types.js";
import {
  backgroundStateBytes,
  cloneBackgroundState,
} from "./background-state.js";
import { ErrexitError, ExitError } from "./errors.js";
import { getFdEntry } from "./fd-table.js";
import { OK } from "./helpers/result.js";
import type { Interpreter } from "./interpreter.js";
import type { InterpreterContext, InterpreterState } from "./types.js";

/** Admit before cloning, allocating descriptors or beginning child effects. */
export function launchBackgroundStatement(
  ctx: InterpreterContext,
  statement: StatementNode,
  create: (
    state: InterpreterState,
    output: InterpreterContext["output"],
  ) => Interpreter,
): ExecResult {
  // Shared extra input/RW descriptions do not yet have concurrent offset semantics.
  if (
    [...(ctx.state.fileDescriptors?.keys() ?? [])].some((fd) => {
      const entry = getFdEntry(ctx, fd);
      return (
        entry?.kind === "readwrite" ||
        (fd >= 3 && !(entry?.kind === "dup-out" && entry.endpoint))
      );
    })
  )
    return {
      stdout: "",
      stderr: "bash: background jobs cannot inherit extra file descriptors\n",
      exitCode: 2,
    };
  const script = {
    type: "Script" as const,
    statements: [{ ...statement, background: false }],
  };
  const args = serialize(script);
  const retainedBytes = backgroundStateBytes(ctx.state);
  const owner = ctx.state.bashPid;
  // Clone before parent updates $!, but only after the shared admission succeeds.
  const pid = ctx.executionScope.shellJobs.launch(
    ctx.state,
    args,
    retainedBytes,
    (pid) => {
      const inherited = ctx.output?.fork(true);
      try {
        const state = cloneBackgroundState(ctx.state);
        state.bashPid = pid;
        state.signal = ctx.state.signal;
        ctx.executionScope.shellJobs.registerOwner(state, args, owner);
        const interpreter = create(state, inherited);
        return async () => {
          try {
            let result: ExecResult;
            try {
              result = await interpreter.executeScript(script);
            } catch (error) {
              if (
                !(error instanceof ExitError || error instanceof ErrexitError)
              )
                throw error;
              result = {
                stdout: error.stdout,
                stderr: error.stderr,
                exitCode: error.exitCode,
                internalOutputSegments: error.internalOutputSegments,
                internalOutputAccounting: error.internalOutputAccounting,
              };
            }
            await ctx.executionScope.shellJobs.wait(pid);
            return result;
          } finally {
            inherited?.release();
          }
        };
      } catch (error) {
        inherited?.release();
        throw error;
      }
    },
  );
  ctx.state.lastBackgroundPid = pid;
  return OK;
}
