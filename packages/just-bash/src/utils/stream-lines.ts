import { BYTE_IO_BLOCK_BYTES, type ByteReader } from "../byte-io.js";
import type { ResourceLease } from "../execution-scope.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../interpreter/errors.js";
import type { RuntimeCommandContext } from "../types.js";

/** File decoding matches readFile; raw stdin is only used by ASCII summaries. */
export async function* readTextLines(
  reader: ByteReader,
  ctx: RuntimeCommandContext,
  raw = false,
  maximumBytes?: number,
  onBlock?: () => Promise<void>,
  site = "text",
): AsyncGenerator<{ value: string; terminated: boolean }> {
  const decoder = new TextDecoder();
  const maximum = ctx.limits.maxStringLength;
  const block = Math.min(
    BYTE_IO_BLOCK_BYTES,
    reader.size ?? BYTE_IO_BLOCK_BYTES,
  );
  const chunkLease = ctx.executionScope?.reserveBytes(
    `${site} decode block`,
    block * 3,
    site,
  );
  const parts: string[] = [];
  let length = 0;
  let read = 0;
  const leases: ResourceLease[] = [];
  const clear = () => {
    parts.length = 0;
    length = 0;
    for (const lease of leases.splice(0)) lease.release();
  };
  const append = (text: string) => {
    if (!text) return;
    if (parts.length >= ctx.limits.maxArrayElements)
      throw new ExecutionLimitError(
        `${site}: pending line element limit exceeded`,
        "array_elements",
      );
    if (text.length > maximum - length)
      throw new ExecutionLimitError(
        `${site}: line text size limit exceeded`,
        "string_length",
      );
    const lease = ctx.executionScope?.reserveBytes(
      `${site} pending line`,
      32 + text.length * 4,
      site,
    );
    if (lease) leases.push(lease);
    parts.push(text);
    length += text.length;
  };
  try {
    for (;;) {
      ctx.executionScope?.throwIfAborted(site);
      if (ctx.signal?.aborted) throw new ExecutionAbortedError();
      const bytes = await reader.read(BYTE_IO_BLOCK_BYTES, ctx.signal);
      ctx.executionScope?.throwIfAborted(site);
      if (ctx.signal?.aborted) throw new ExecutionAbortedError();
      read += bytes?.byteLength ?? 0;
      if (maximumBytes !== undefined && read > maximumBytes)
        throw new ExecutionLimitError(
          `${site}: file grew while being read`,
          "string_length",
        );
      ctx.executionScope?.consumeWork(1, `${site} byte block`);
      let text = "";
      if (raw && bytes) {
        for (let i = 0; i < bytes.length; i += 8192)
          text += String.fromCharCode(...bytes.subarray(i, i + 8192));
      } else if (!raw)
        text = decoder.decode(bytes ?? undefined, { stream: bytes !== null });
      let start = 0;
      for (
        let end = text.indexOf("\n");
        end !== -1;
        end = text.indexOf("\n", start)
      ) {
        append(text.slice(start, end));
        yield {
          value: parts.length === 1 ? parts[0] : parts.join(""),
          terminated: true,
        };
        clear();
        start = end + 1;
      }
      append(text.slice(start));
      if (bytes !== null) await onBlock?.();
      if (bytes === null) {
        if (length)
          yield {
            value: parts.length === 1 ? parts[0] : parts.join(""),
            terminated: false,
          };
        return;
      }
    }
  } finally {
    clear();
    chunkLease?.release();
  }
}
