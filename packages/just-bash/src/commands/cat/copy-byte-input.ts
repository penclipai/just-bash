import {
  BYTE_IO_BLOCK_BYTES,
  type ByteReader,
  type ByteWriter,
} from "../../byte-io.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import { accountFileInput } from "../../utils/file-reader.js";

export async function copyByteInput(
  ctx: RuntimeCommandContext,
  reader: ByteReader,
  writer: ByteWriter,
  aggregate: number,
  limit: number,
  file: boolean,
): Promise<number> {
  const check = (bytes: number) => {
    if (bytes > limit - aggregate)
      throw new ExecutionLimitError(
        "cat: output size limit exceeded",
        "output_size",
      );
  };
  if (reader.size !== undefined) check(reader.size);
  for (;;) {
    ctx.executionScope?.consumeWork(1, "cat byte block");
    const chunk = await reader.read(BYTE_IO_BLOCK_BYTES, ctx.signal);
    if (chunk === null) break;
    check(chunk.byteLength);
    if (file) accountFileInput(ctx, chunk.byteLength, "cat");
    aggregate += chunk.byteLength;
    await writer.write(chunk, ctx.signal);
  }
  return aggregate;
}
