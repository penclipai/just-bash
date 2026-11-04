import { AST, type CommandNode, type RedirectionNode } from "../ast/types.js";
import { closeFd, restoreFds, snapshotFds } from "./fd-table.js";
import type { InterpreterContext } from "./types.js";

export const PIPE_STDERR_REDIRECTION: RedirectionNode = AST.redirection(
  ">&",
  AST.word([AST.literal("1")]),
  2,
);

export function withPipedStderr(command: CommandNode): CommandNode {
  // Function definition redirects belong to later calls, not the definition.
  if (command.type === "FunctionDef") return command;
  return {
    ...command,
    redirections: [...command.redirections, PIPE_STDERR_REDIRECTION],
  };
}

/** Give a non-final stage its pipe stdout, retaining the enclosing FD routes. */
export function bindPipelineOutput(
  ctx: InterpreterContext,
  pipeStderr: boolean,
): () => void {
  const fds = pipeStderr ? [1, 2] : [1];
  const snapshot = snapshotFds(ctx, fds);
  const closed = new Set(
    fds.filter((fd) => ctx.state.closedStandardFds?.has(fd)),
  );
  // Reuse the live-stream fallback without allocating an extra descriptor.
  closeFd(ctx, 1);
  ctx.state.closedStandardFds?.delete(1);
  return () => {
    restoreFds(ctx, snapshot);
    for (const fd of fds) {
      if (closed.has(fd)) {
        ctx.state.closedStandardFds ??= new Set();
        ctx.state.closedStandardFds.add(fd);
      } else {
        ctx.state.closedStandardFds?.delete(fd);
      }
    }
  };
}
