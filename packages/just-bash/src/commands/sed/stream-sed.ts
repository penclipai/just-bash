import type { ResourceLease } from "../../execution-scope.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type { ExecResult, RuntimeCommandContext } from "../../types.js";
import { accountFileInput } from "../../utils/file-reader.js";
import { readTextLines } from "../../utils/stream-lines.js";
import { withByteReader } from "../../utils/with-byte-reader.js";
import { processContent } from "./process-content.js";
import type { SedCommand } from "./types.js";

/** Stateful, lookahead, side-effecting and whole-stdin scripts keep one engine. */
export function canStreamSed(
  ctx: RuntimeCommandContext,
  files: string[],
  commands: SedCommand[],
): boolean {
  if (
    !ctx.fs.openByteReader ||
    !ctx.writeOutput ||
    files.length !== 1 ||
    files[0] === "-"
  )
    return false;
  const pending = [commands];
  while (pending.length) {
    const group = pending.pop();
    if (!group) continue;
    for (const command of group) {
      if (command.type === "label") return false;
      const address = command.address;
      if (
        address?.start === "$" ||
        address?.end === "$" ||
        (address?.end !== undefined &&
          !(
            typeof address.start === "number" &&
            typeof address.end === "number" &&
            address.start <= address.end
          ))
      )
        return false;
      switch (command.type) {
        case "substitute":
          if (!command.pattern) return false;
          break;
        case "print":
        case "printFirstLine":
        case "delete":
        case "append":
        case "insert":
        case "change":
        case "transliterate":
        case "lineNumber":
        case "list":
        case "zap":
        case "printFilename":
          break;
        case "group":
          pending.push(command.commands);
          break;
        default:
          return false;
      }
      const start = command.address?.start;
      if (typeof start === "object" && "pattern" in start && !start.pattern)
        return false;
    }
  }
  return true;
}

export async function streamSedFile(
  ctx: RuntimeCommandContext,
  file: string,
  commands: SedCommand[],
  silent: boolean,
): Promise<ExecResult> {
  const open = ctx.fs.openByteReader;
  const write = ctx.writeOutput;
  if (!open || !write) throw new Error("sed: missing streaming capabilities");
  const check = () => {
    ctx.executionScope?.throwIfAborted("sed");
    if (ctx.signal?.aborted) throw new ExecutionAbortedError();
  };
  const path = ctx.fs.resolvePath(ctx.cwd, file);
  const stat = await ctx.fs.stat(path);
  accountFileInput(ctx, stat.size, "sed");
  let pending = "";
  const leases: ResourceLease[] = [];
  const release = () => {
    for (const lease of leases.splice(0)) lease.release();
  };
  const flush = async () => {
    check();
    if (!pending) return;
    await write(pending, "stdout", "text");
    check();
    pending = "";
    release();
  };
  try {
    await withByteReader(await open.call(ctx.fs, path), async (reader) => {
      let line = 0,
        outputLength = 0;
      for await (const input of readTextLines(
        reader,
        ctx,
        false,
        stat.size,
        flush,
        "sed",
      )) {
        const result = await processContent(
          input.value + (input.terminated ? "\n" : ""),
          commands,
          silent,
          {
            limits: ctx.limits,
            filename: file,
            coverage: ctx.coverage,
            requireDefenseContext: ctx.requireDefenseContext,
            lineNumberOffset: line++,
          },
        );
        outputLength += result.output.length;
        if (outputLength > ctx.limits.maxStringLength)
          throw new ExecutionLimitError(
            "sed: output size limit exceeded",
            "string_length",
          );
        for (let start = 0; start < result.output.length; ) {
          let end = Math.min(result.output.length, start + 16_384);
          const last = result.output.charCodeAt(end - 1);
          if (end < result.output.length && last >= 0xd800 && last <= 0xdbff)
            end--;
          const piece = result.output.slice(start, end);
          if (pending.length + piece.length > 16_384) await flush();
          const lease = ctx.executionScope?.reserveBytes(
            "sed pending output",
            piece.length * 4,
            "sed",
          );
          if (lease) leases.push(lease);
          pending += piece;
          start = end;
          if (pending.length >= 16_384) await flush();
        }
      }
    });
    await flush();
  } finally {
    release();
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
