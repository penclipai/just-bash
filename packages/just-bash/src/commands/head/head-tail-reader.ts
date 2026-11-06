import { BoundedStringBuilder } from "../../bounded-builder.js";
import { BYTE_IO_BLOCK_BYTES, type ByteReader } from "../../byte-io.js";
import { stringFromBytes } from "../../byte-string.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import { readByteRange } from "../../utils/read-byte-range.js";
import type { HeadTailOptions } from "./head-tail-shared.js";

/** Select bytes before converting them, without materializing unused input. */
export async function selectFromByteReader(
  reader: ByteReader,
  options: HeadTailOptions,
  command: "head" | "tail",
  ctx: RuntimeCommandContext,
): Promise<string | null> {
  const maximum = Math.min(
    ctx.limits.maxOutputSize,
    ctx.limits.maxStringLength,
  );
  const output = new BoundedStringBuilder(maximum, command);
  const check = () =>
    ctx.executionScope?.consumeWork(1, `${command} byte block`);
  if (command === "head") {
    let remaining = options.bytes ?? options.lines;
    while (remaining > 0) {
      check();
      const chunk = await reader.read(
        options.bytes === null
          ? BYTE_IO_BLOCK_BYTES
          : Math.min(BYTE_IO_BLOCK_BYTES, remaining),
        ctx.signal,
      );
      if (chunk === null) break;
      let end = chunk.length;
      if (options.bytes !== null) remaining -= chunk.length;
      else
        for (let at = 0; at < chunk.length; at++) {
          if (chunk[at] === 10 && --remaining === 0) {
            end = at + 1;
            break;
          }
        }
      output.append(stringFromBytes(chunk.subarray(0, end)));
    }
    return output.build();
  }
  if (options.fromLine && options.bytes === null) {
    let skip = Math.max(0, options.lines - 1);
    for (;;) {
      check();
      const chunk = await reader.read(BYTE_IO_BLOCK_BYTES, ctx.signal);
      if (chunk === null) break;
      let at = 0;
      for (; at < chunk.length && skip > 0; at++) if (chunk[at] === 10) skip--;
      if (!skip) output.append(stringFromBytes(chunk.subarray(at)));
    }
    return output.build();
  }
  if (reader.size === undefined || !reader.readAt) return null;
  const readAt = reader.readAt.bind(reader);
  let end = reader.size;
  if (options.bytes !== null) {
    let offset = Math.max(0, end - options.bytes);
    while (offset < end) {
      check();
      const chunk = await readByteRange(
        readAt,
        offset,
        Math.min(BYTE_IO_BLOCK_BYTES, end - offset),
        ctx.signal,
      );
      output.append(stringFromBytes(chunk));
      offset += chunk.length;
    }
    return output.build();
  }
  if (options.lines === 0) return "";
  const pieces: string[] = [];
  let remaining = options.lines,
    retained = 0;
  while (end > 0 && remaining > 0) {
    check();
    const start = Math.max(0, end - BYTE_IO_BLOCK_BYTES);
    const chunk = await readByteRange(readAt, start, end - start, ctx.signal);
    let from = 0;
    for (let at = chunk.length - 1; at >= 0; at--) {
      if (start + at === reader.size - 1 && chunk[at] === 10) continue;
      if (chunk[at] === 10 && --remaining === 0) {
        from = at + 1;
        break;
      }
    }
    retained += chunk.length - from;
    if (retained > maximum || pieces.length >= ctx.limits.maxArrayElements)
      throw new ExecutionLimitError(
        `${command}: output size limit exceeded`,
        "output_size",
      );
    pieces.push(stringFromBytes(chunk.subarray(from)));
    end = start;
  }
  for (let at = pieces.length - 1; at >= 0; at--) output.append(pieces[at]);
  return output.build();
}
