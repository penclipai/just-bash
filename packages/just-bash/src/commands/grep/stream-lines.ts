import type { ByteReader } from "../../byte-io.js";
import type { RuntimeCommandContext } from "../../types.js";
import { readTextLines } from "../../utils/stream-lines.js";

export function grepLines(
  reader: ByteReader,
  ctx: RuntimeCommandContext,
  raw = false,
  maximumBytes?: number,
  onBlock?: () => Promise<void>,
): AsyncGenerator<{ value: string; terminated: boolean }> {
  return readTextLines(reader, ctx, raw, maximumBytes, onBlock, "grep");
}
