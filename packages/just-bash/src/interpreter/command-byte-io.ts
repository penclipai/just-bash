import {
  BYTE_IO_BLOCK_BYTES,
  type ByteReader,
  type CommandByteIO,
} from "../byte-io.js";
import { stringFromBytes } from "../byte-string.js";
import type { RuntimeCommandContext } from "../types.js";
import { ExecutionAbortedError } from "./errors.js";
import type { PipeCommandOutputs } from "./pipe-endpoints.js";

/** Adapt the existing descriptions without introducing another input cursor. */
export function createCommandByteIO(
  context: Pick<RuntimeCommandContext, "readStdinChunk" | "writeOutput"> &
    Partial<Pick<RuntimeCommandContext, "executionScope" | "limits">>,
  reader: ByteReader,
  outputs?: PipeCommandOutputs,
): CommandByteIO {
  const writer = (stream: "stdout" | "stderr") => {
    let ended = false;
    let aborted = false;
    let serial: Promise<unknown> = Promise.resolve();
    return {
      write(bytes: Uint8Array, signal?: AbortSignal) {
        if (signal?.aborted) throw new ExecutionAbortedError();
        if (ended) throw new Error("Byte writer is closed");
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > BYTE_IO_BLOCK_BYTES
        )
          throw new TypeError("Invalid byte write block");
        if (!bytes.byteLength) return Promise.resolve();
        const lease = context.executionScope?.reserveBytes(
          "pending byte write",
          bytes.byteLength + 64,
          "byte write",
        );
        const write = async () => {
          if (aborted || signal?.aborted) throw new ExecutionAbortedError();
          const target = outputs?.[stream];
          if (target) {
            if (context.limits)
              context.executionScope?.consumeLimited(
                "output chunks",
                1,
                context.limits.maxArrayElements,
                "byte write",
              );
            await target.write(bytes, signal);
          } else
            await context.writeOutput?.(
              stringFromBytes(bytes),
              stream,
              "bytes",
            );
        };
        const result = serial
          .then(write, write)
          .finally(() => lease?.release());
        serial = result.catch(() => {});
        return result;
      },
      async close() {
        ended = true;
        await serial;
      },
      async abort() {
        ended = true;
        aborted = true;
        await serial;
      },
    };
  };
  return {
    stdin: reader,
    stdout: writer("stdout"),
    stderr: writer("stderr"),
  };
}
