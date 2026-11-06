import { BYTE_IO_BLOCK_BYTES, type ByteReader } from "../../byte-io.js";
import { latin1FromBytes } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import type { RuntimeCommandContext } from "../../types.js";
import { bufferByteReader } from "../../utils/buffer-byte-reader.js";
import { accountFileInput } from "../../utils/file-reader.js";
import { fsErrorMessage } from "../../utils/fs-error.js";
import { readStdin } from "../../utils/read-stdin.js";
import { withByteReader } from "../../utils/with-byte-reader.js";
import {
  createWcCounter,
  type WcCounts,
  type WcSelection,
} from "./byte-counts.js";

export async function readWcCounts(
  ctx: RuntimeCommandContext,
  files: string[],
  selection: WcSelection,
): Promise<{
  files: Array<{ filename: string; stats: WcCounts }>;
  stderr: string;
  exitCode: number;
}> {
  const counted: Array<{ filename: string; stats: WcCounts }> = [];
  let stderr = "",
    exitCode = 0;
  for (const filename of files.length ? files : [""]) {
    const stdin = filename === "" || filename === "-";
    let reader: ByteReader | undefined;
    let sizeOnly = false;
    try {
      if (stdin && ctx.byteIO) reader = ctx.byteIO.stdin;
      else if (stdin) {
        const value = latin1FromBytes(await readStdin(ctx));
        reader = bufferByteReader(
          Uint8Array.from(value, (character) => character.charCodeAt(0)),
        );
      } else {
        const path = ctx.fs.resolvePath(ctx.cwd, filename);
        sizeOnly =
          Boolean(ctx.fs.openByteReader) &&
          !selection.lines &&
          !selection.words &&
          !selection.chars &&
          (await ctx.fs.stat(path)).isFile;
        reader = ctx.fs.openByteReader
          ? await ctx.fs.openByteReader(path)
          : bufferByteReader(await ctx.fs.readFileBuffer(path));
      }
      const count = async (input: ByteReader): Promise<WcCounts> => {
        if (sizeOnly && input.size !== undefined) {
          accountFileInput(ctx, input.size, "wc");
          return { lines: 0, words: 0, third: input.size, bytes: input.size };
        }
        const counter = createWcCounter(selection);
        for (;;) {
          const chunk = await input.read(BYTE_IO_BLOCK_BYTES, ctx.signal);
          if (chunk === null) break;
          ctx.executionScope?.consumeWork(1, "wc byte block");
          if (!stdin) accountFileInput(ctx, chunk.byteLength, "wc");
          counter.update(chunk);
        }
        return counter.finish();
      };
      const stats = stdin
        ? await count(reader)
        : await withByteReader(reader, count);
      counted.push({ filename, stats });
    } catch (error) {
      rethrowFatalExecutionError(error);
      stderr += `wc: ${filename}: ${fsErrorMessage(error)}\n`;
      exitCode = 1;
    }
  }
  return { files: counted, stderr, exitCode };
}
