import type { CommandNode, PipelineNode } from "../ast/types.js";
import { outputSegments } from "../execution-output.js";
import { _performanceNow } from "../security/trusted-globals.js";
import { serialize } from "../transform/serialize.js";
import type { ExecResult } from "../types.js";
import { backgroundStateBytes } from "./background-state.js";
import { createBytePipe } from "./byte-pipe.js";
import {
  drainDescriptions,
  registerDescriptionLifetime,
} from "./description-lifetime.js";
import { releaseOwnedDescriptors } from "./descriptor-state.js";
import { BadSubstitutionError, ErrexitError, ExitError } from "./errors.js";
import {
  attachInputSession,
  dupFd,
  readFd,
  restoreFds,
  shareFdDescriptions,
  snapshotFds,
} from "./fd-table.js";
import { clearArray, setArrayElement } from "./helpers/array.js";
import { closeLiveInput, createLiveInput } from "./live-input.js";
import type { OutputEndpoints } from "./output-endpoints.js";
import { createPipeOutputEndpoint } from "./pipe-endpoints.js";
import { withPipedStderr } from "./pipeline-redirections.js";
import { beginIsolatedShellState } from "./state-transaction.js";
import type {
  InterpreterContext,
  InterpreterState,
  SharedInputSession,
} from "./types.js";

export type PipelineStageFactory = (
  state: InterpreterState,
  input: SharedInputSession | undefined,
  endpoints: OutputEndpoints | undefined,
  output: InterpreterContext["output"],
  child: boolean,
) => (command: CommandNode) => Promise<ExecResult>;

export async function executeConcurrentPipeline(
  ctx: InterpreterContext,
  node: PipelineNode,
  create: PipelineStageFactory,
): Promise<ExecResult> {
  const start = _performanceNow();
  const scope = ctx.executionScope;
  const owner = ctx.state.bashPid;
  const lastArg = ctx.state.lastArg;
  const savedGroup = ctx.state.groupStdin;
  const savedSource = ctx.state.groupStdinSourceFd;
  const parentInput = snapshotFds(ctx, [0]);
  let sharedGroup: SharedInputSession | undefined;
  if (savedGroup !== undefined) {
    if (savedSource !== undefined && savedSource >= 0)
      dupFd(ctx, 0, savedSource);
    else {
      sharedGroup = { remaining: savedGroup };
      attachInputSession(ctx, sharedGroup);
    }
    ctx.state.groupStdin = undefined;
    ctx.state.groupStdinSourceFd = undefined;
  }
  shareFdDescriptions(ctx);
  const pipes = node.commands
    .slice(1)
    .map(() =>
      createBytePipe(
        scope,
        Math.min(ctx.limits.maxOutputSize, ctx.limits.maxStringLength),
      ),
    );
  const outputs = pipes.map((pipe) => createPipeOutputEndpoint(pipe, scope));
  const inputs = pipes.map((pipe) => {
    const input = createLiveInput(
      { readChunk: (signal) => pipe.reader.read(undefined, signal) },
      scope,
      ctx.state.signal,
      ctx.limits.maxStringLength,
    );
    registerDescriptionLifetime(input, scope, async () => {
      await closeLiveInput(input);
      await pipe.reader.close();
    });
    return input;
  });
  const results: ExecResult[] = new Array(node.commands.length);
  const tasks: Promise<unknown>[] = [];
  const last = node.commands.length - 1;
  let parentRun: (() => Promise<void>) | undefined;
  const runStage = async (
    index: number,
    state: InterpreterState,
    child: boolean,
    input: SharedInputSession | undefined,
    output: InterpreterContext["output"],
  ) => {
    const endpoint =
      index < last
        ? { ...ctx.outputEndpoints, stdout: outputs[index] }
        : ctx.outputEndpoints;
    const run = create(state, input, endpoint, output, child);
    const command = node.pipeStderr?.[index]
      ? withPipedStderr(node.commands[index])
      : node.commands[index];
    const pipelineActive = state.automaPipelineActive;
    state.automaPipelineActive = true;
    try {
      state.commandCount = scope.chargeCommand();
      try {
        results[index] = await run(command);
      } catch (error) {
        if (
          error instanceof BadSubstitutionError ||
          error instanceof ExitError ||
          error instanceof ErrexitError
        )
          results[index] = {
            stdout: error.stdout,
            stderr: error.stderr,
            exitCode:
              error instanceof BadSubstitutionError ? 1 : error.exitCode,
            internalOutputSegments: error.internalOutputSegments,
            internalOutputAccounting: error.internalOutputAccounting,
          };
        else throw error;
      }
      // Definition-time diagnostics have no executed redirection transaction.
      if (
        index < last &&
        node.pipeStderr?.[index] &&
        command.type === "FunctionDef"
      ) {
        const result = results[index];
        if (result.stderr) await outputs[index].write(result.stderr, "text");
        results[index] = {
          ...result,
          stderr: "",
          internalOutputSegments: outputSegments(result).filter(
            (part) => part[0] !== "stderr",
          ),
        };
      }
    } finally {
      state.automaPipelineActive = pipelineActive;
      if (child) releaseOwnedDescriptors(state);
    }
    await scope.shellJobs.wait(state.bashPid);
  };
  try {
    for (let index = 0; index <= last; index++) {
      if (index === last && ctx.state.shoptOptions.lastpipe) {
        parentRun = async () => {
          const stageInput = snapshotFds(ctx, [0]);
          const output = ctx.output?.fork(true);
          try {
            attachInputSession(ctx, inputs[index - 1]);
            await runStage(index, ctx.state, false, undefined, output);
          } finally {
            restoreFds(ctx, stageInput);
            output?.release();
          }
        };
        continue;
      }
      const pid = scope.shellJobs.launch(
        ctx.state,
        serialize({
          type: "Script",
          statements: [
            {
              type: "Statement",
              pipelines: [
                {
                  ...node,
                  commands: [node.commands[index]],
                  timed: false,
                  negated: false,
                },
              ],
              background: false,
              operators: [],
            },
          ],
        }),
        backgroundStateBytes(ctx.state),
        (allocated) => {
          const state = { ...ctx.state };
          beginIsolatedShellState(state);
          state.bashPid = allocated;
          state.lastArg = "";
          scope.shellJobs.registerOwner(state, "pipeline", owner);
          const output = ctx.output?.fork(true);
          return async () => {
            try {
              await runStage(
                index,
                state,
                true,
                index ? inputs[index - 1] : undefined,
                output,
              );
              return results[index];
            } finally {
              output?.release();
            }
          };
        },
        true,
      );
      tasks.push(scope.shellJobs.wait(owner, [pid]));
    }
    if (parentRun) tasks.push(parentRun());
    await Promise.all(tasks);
    await drainDescriptions(scope);
  } catch (error) {
    scope.shellJobs.cancel(error);
    await Promise.allSettled(pipes.map((pipe) => pipe.cancel(error)));
    await Promise.allSettled(tasks);
    throw scope.shellJobs.signal.reason ?? error;
  } finally {
    restoreFds(ctx, parentInput);
    if (savedGroup !== undefined) {
      const remainder =
        savedSource !== undefined && savedSource >= 0
          ? readFd(ctx, savedSource)
          : undefined;
      ctx.state.groupStdin =
        sharedGroup?.remaining ??
        (remainder && "content" in remainder ? remainder.content : savedGroup);
      ctx.state.groupStdinSourceFd = savedSource;
    }
  }
  const statuses = results.map((result) => result.exitCode);
  clearArray(ctx, "PIPESTATUS");
  for (let index = 0; index < statuses.length; index++)
    setArrayElement(ctx, "PIPESTATUS", index, String(statuses[index]));
  const result = results[last];
  let exitCode = result.exitCode;
  if (ctx.state.options.pipefail)
    for (let index = statuses.length - 1; index >= 0; index--)
      if (statuses[index]) {
        exitCode = statuses[index];
        break;
      }
  if (node.negated) exitCode = exitCode ? 0 : 1;
  let stderr = results.map((result) => result.stderr).join("");
  if (node.timed) {
    const seconds = (_performanceNow() - start) / 1000;
    stderr += node.timePosix
      ? `real ${seconds.toFixed(2)}\nuser 0.00\nsys 0.00\n`
      : `\nreal\t${Math.floor(seconds / 60)}m${(seconds % 60).toFixed(3)}s\nuser\t0m0.000s\nsys\t0m0.000s\n`;
  }
  if (!ctx.state.shoptOptions.lastpipe) ctx.state.lastArg = lastArg;
  return {
    ...result,
    stderr,
    exitCode,
    internalOutputSegments: [
      ...results
        .slice(0, last)
        .flatMap((result) =>
          outputSegments(result).filter((part) => part[0] === "stderr"),
        ),
      ...outputSegments(result),
    ],
  };
}
