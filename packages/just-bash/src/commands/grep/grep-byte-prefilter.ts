import { containsAsciiBytes } from "../../fs/ascii-search.js";
import { fromBuffer } from "../../fs/encoding.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import type { PreFilter } from "../search-engine/regex.js";

/** ASCII cannot occur inside a UTF-8 multibyte character. A missing literal
 * therefore proves a negative before allocating or decoding a large body. */
export function asciiPrefixFor(
  prefilter: PreFilter | undefined,
): string | undefined {
  if (!prefilter || prefilter.ignoreCase || prefilter.needles.length !== 1)
    return undefined;
  // Bound the work at every possible byte position even on repetitive input.
  // A present prefix merely sends the entire file to the existing matcher.
  const needle = prefilter.needles[0].slice(0, 4);
  if (!needle || [...needle].some((character) => character.charCodeAt(0) > 127))
    return undefined;
  return needle;
}

export async function readGrepText(
  ctx: RuntimeCommandContext,
  path: string,
  size: number,
  prefix?: string,
): Promise<string> {
  ctx.executionScope?.throwIfAborted("grep");
  if (ctx.signal?.aborted) throw new ExecutionAbortedError();
  // The provider can prove a miss on a current, immutable cached file of the
  // expected size without transferring a second copy into the command realm.
  const largePrefix = size >= 16_384 ? prefix : undefined;
  const missing =
    largePrefix &&
    (await ctx.fs.cachedFileMissingPrefix?.(path, largePrefix, size));
  const bytes = missing ? undefined : await ctx.fs.readFileBuffer(path);
  ctx.executionScope?.throwIfAborted("grep");
  if (ctx.signal?.aborted) throw new ExecutionAbortedError();
  if (bytes && bytes.byteLength > size) {
    throw new ExecutionLimitError(
      "grep: file grew while being read",
      "string_length",
    );
  }
  ctx.executionScope?.consumeInput(bytes?.byteLength ?? size, "grep");
  if (!bytes || (largePrefix && !containsAsciiBytes(bytes, largePrefix)))
    return "";
  return fromBuffer(bytes);
}
