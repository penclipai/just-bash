import { combineAbortSignals } from "../abort-signals.js";
import {
  BYTE_IO_BLOCK_BYTES,
  type ByteReader,
  type ByteWriter,
} from "../byte-io.js";
import {
  type ExecutionScope,
  type ResourceLease,
  relinquishPipelineOutput,
} from "../execution-scope.js";
import { BrokenPipeError } from "./broken-pipe-error.js";
import { ExecutionAbortedError, ExecutionLimitError } from "./errors.js";

export { BrokenPipeError } from "./broken-pipe-error.js";

interface Block {
  bytes: Uint8Array;
  offset: number;
  lease: ResourceLease;
}
export interface BytePipe {
  reader: ByteReader;
  writer(): ByteWriter;
  cancel(reason?: unknown): Promise<void>;
}

/** Two retained blocks, including the reader's currently borrowed block. */
export function createBytePipe(
  scope: ExecutionScope,
  maximumOutput: number,
): BytePipe {
  const queue: Block[] = [];
  const waiters = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  let borrowed: Block | undefined;
  let readersClosed = false,
    writers = 0,
    produced = 0;
  let failure: unknown;
  let unregister = () => {};
  const finished = () => {
    if (readersClosed && writers === 0 && pending.size === 0 && !scope.isClosed)
      unregister();
  };
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const release = (block: Block) => {
    block.lease.release();
    if (!scope.isClosed && !scope.failure && !scope.signal?.aborted)
      relinquishPipelineOutput(
        scope,
        block.bytes.length - block.offset,
        "pipe buffer",
      );
  };
  const wait = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const lease = scope.reserveBytes(48, "pipe waiter");
      const combined = combineAbortSignals(
        signal,
        scope.signal,
        scope.shellJobs.signal,
      );
      const cleanup = () => {
        waiters.delete(finish);
        combined.signal?.removeEventListener("abort", abort);
        combined.cleanup();
        lease.release();
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        try {
          check(signal);
        } catch (error) {
          reject(error);
          return;
        }
        reject(new ExecutionAbortedError());
      };
      waiters.add(finish);
      combined.signal?.addEventListener("abort", abort, { once: true });
      if (combined.signal?.aborted) abort();
    });
  const check = (signal?: AbortSignal) => {
    if (failure !== undefined) throw failure;
    if (scope.failure) throw scope.failure;
    if (scope.shellJobs.signal.aborted)
      throw scope.shellJobs.signal.reason ?? new ExecutionAbortedError();
    if (signal?.aborted) throw new ExecutionAbortedError();
    scope.throwIfAborted("pipe");
  };
  const closeReader = () => {
    readersClosed = true;
    if (borrowed) {
      release(borrowed);
      borrowed = undefined;
    }
    while (queue.length) {
      const block = queue.shift();
      if (block) release(block);
    }
    wake();
    finished();
  };
  const pipe: BytePipe = {
    reader: {
      async read(maxBytes = BYTE_IO_BLOCK_BYTES, signal) {
        if (
          !Number.isSafeInteger(maxBytes) ||
          maxBytes <= 0 ||
          maxBytes > BYTE_IO_BLOCK_BYTES
        )
          throw new RangeError("Invalid pipe read size");
        check(signal);
        if (borrowed) {
          release(borrowed);
          borrowed = undefined;
          wake();
        }
        while (!queue.length && !readersClosed && writers) {
          await wait(signal);
          check(signal);
        }
        if (readersClosed || !queue.length) {
          closeReader();
          return null;
        }
        const block = queue[0];
        const end = Math.min(block.bytes.length, block.offset + maxBytes);
        const chunk = block.bytes.subarray(block.offset, end);
        block.offset = end;
        relinquishPipelineOutput(scope, chunk.length, "pipe input");
        if (end === block.bytes.length) {
          queue.shift();
          borrowed = block;
        }
        return chunk;
      },
      async close() {
        closeReader();
      },
      async cancel(reason) {
        await pipe.cancel(reason);
      },
    },
    writer() {
      writers++;
      let ended = false,
        aborted = false;
      let serial: Promise<unknown> = Promise.resolve();
      let closing: Promise<void> | undefined;
      const close = () => {
        ended = true;
        closing ??= serial.then(() => {
          writers--;
          wake();
          finished();
        });
        return closing;
      };
      return {
        write(bytes, signal) {
          if (ended) return Promise.reject(new BrokenPipeError());
          if (
            !(bytes instanceof Uint8Array) ||
            bytes.length > BYTE_IO_BLOCK_BYTES
          )
            return Promise.reject(new TypeError("Invalid pipe write block"));
          const write = async () => {
            check(signal);
            if (aborted || readersClosed) throw new BrokenPipeError();
            while (queue.length + Number(Boolean(borrowed)) >= 2) {
              await wait(signal);
              check(signal);
              if (aborted || readersClosed) throw new BrokenPipeError();
            }
            if (bytes.length > maximumOutput - produced)
              throw new ExecutionLimitError(
                `pipeline: total output size exceeded (>${maximumOutput} bytes), increase executionLimits.maxOutputSize`,
                "output_size",
              );
            scope.consumeWork(1, "pipe block");
            const lease = scope.reserveBytes(bytes.length + 64, "pipe block");
            try {
              const owned = bytes.slice();
              scope.chargeOutputBytes(bytes.length, "pipe block");
              produced += owned.length;
              queue.push({ bytes: owned, offset: 0, lease });
              wake();
            } catch (error) {
              lease.release();
              throw error;
            }
          };
          const result = serial.then(write, write);
          serial = result.catch(() => {});
          pending.add(result);
          const settled = () => {
            pending.delete(result);
            finished();
          };
          result.then(settled, settled);
          return result;
        },
        close,
        async abort() {
          aborted = true;
          wake();
          await close();
        },
      };
    },
    async cancel(reason = new ExecutionAbortedError()) {
      failure ??= reason;
      closeReader();
      await Promise.allSettled([...pending]);
    },
  };
  unregister = scope.registerCleanup(() => pipe.cancel());
  return pipe;
}
