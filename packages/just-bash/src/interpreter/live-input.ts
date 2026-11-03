import { combineAbortSignals, raceCancellation } from "../abort-signals.js";
import { bytesFromUint8Array, latin1FromBytes } from "../encoding.js";
import type { ExecutionScope } from "../execution-scope.js";
import { _clearFiniteTimeout, _setTimeoutIfFinite } from "../timers.js";
import type { CommandExecOptions } from "../types.js";
import { ExecutionAbortedError, ExecutionLimitError } from "./errors.js";
import type { SharedInputSession } from "./types.js";

/** One open input description shared by fd aliases and nested shells. */
export function createLiveInput(
  source: NonNullable<CommandExecOptions["stdinSource"]>,
  scope: ExecutionScope,
  signal: AbortSignal | undefined,
  maxStringLength: number,
): SharedInputSession {
  let ended = false;
  let pending:
    | {
        promise: Promise<boolean>;
        controller: AbortController;
        readers: number;
      }
    | undefined;
  scope.registerCleanup(() => pending?.controller.abort());
  const session: SharedInputSession = {
    remaining: "",
    async readMore(readerSignal) {
      if (readerSignal?.aborted)
        throw new ExecutionAbortedError("", "bash: stdin read aborted\n");
      if (ended) return false;
      if (!pending) {
        const controller = new AbortController();
        const combined = combineAbortSignals(signal, controller.signal);
        const entry = {
          controller,
          readers: 0,
          promise: Promise.resolve(false),
        };
        pending = entry;
        entry.promise = (async () => {
          scope.consumeWork(1, "stdin chunk");
          let timer: ReturnType<typeof _setTimeoutIfFinite>;
          let chunk: Uint8Array | null;
          try {
            chunk = await Promise.race([
              raceCancellation(
                source.readChunk(combined.signal),
                combined.signal,
                "bash: stdin read aborted\n",
              ),
              new Promise<never>((_resolve, reject) => {
                timer = _setTimeoutIfFinite(
                  () =>
                    reject(
                      new ExecutionAbortedError(
                        "",
                        "bash: stdin exceeded execution deadline\n",
                      ),
                    ),
                  scope.remainingTimeMs(),
                );
              }),
            ]);
          } finally {
            _clearFiniteTimeout(timer);
          }
          scope.throwIfAborted("stdin");
          if (chunk === null) {
            ended = true;
            return false;
          }
          scope.consumeInput(chunk.byteLength, "stdin");
          if (chunk.byteLength > maxStringLength - session.remaining.length)
            throw new ExecutionLimitError(
              "stdin size limit exceeded",
              "string_length",
            );
          session.remaining += latin1FromBytes(bytesFromUint8Array(chunk));
          return true;
        })().finally(() => {
          entry.controller.abort();
          combined.cleanup();
          if (pending === entry) pending = undefined;
        });
      }
      const entry = pending;
      entry.readers++;
      try {
        return await raceCancellation(
          entry.promise,
          readerSignal,
          "bash: stdin read aborted\n",
        );
      } finally {
        if (--entry.readers === 0 && pending === entry) {
          pending = undefined;
          entry.controller.abort();
        }
      }
    },
  };
  return session;
}
