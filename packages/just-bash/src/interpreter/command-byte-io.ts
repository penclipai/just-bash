import {
  BYTE_IO_BLOCK_BYTES,
  type ByteReader,
  type CommandByteIO,
} from "../byte-io.js";
import { stringFromBytes } from "../byte-string.js";
import type { RuntimeCommandContext } from "../types.js";
import { ExecutionAbortedError } from "./errors.js";

/** Adapt the existing descriptions without introducing another input cursor. */
export function createCommandByteIO(
  context: Pick<RuntimeCommandContext, "readStdinChunk" | "writeOutput">,
  reader: ByteReader,
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
        const write = async () => {
          if (aborted || signal?.aborted) throw new ExecutionAbortedError();
          await context.writeOutput?.(stringFromBytes(bytes), stream, "bytes");
        };
        const result = serial.then(write, write);
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
