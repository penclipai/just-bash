import type { ByteReader, CommandByteIO } from "../../byte-io.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type { UserRegex } from "../../regex/index.js";
import type { ExecResult, RuntimeCommandContext } from "../../types.js";
import { accountFileInput } from "../../utils/file-reader.js";
import { fsErrorMessage } from "../../utils/fs-error.js";
import { matchGlob } from "../../utils/glob.js";
import { withByteReader } from "../../utils/with-byte-reader.js";
import type { PreFilter } from "../search-engine/regex.js";
import { grepLines } from "./stream-lines.js";
import { GrepOutput } from "./stream-output.js";

interface StreamFile {
  path: string;
  isFile?: boolean;
  isStdin?: boolean;
  stdinAtEof?: boolean;
}

function asciiPattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++)
    if (pattern.charCodeAt(i) >= 128) return false;
  return true;
}
export interface GrepStreamOptions {
  invertMatch: boolean;
  showLineNumbers: boolean;
  countOnly: boolean;
  filesWithMatches: boolean;
  filesWithoutMatch: boolean;
  quietMode: boolean;
  recursive: boolean;
  showFilename: boolean;
  maxCount: number;
  maxWork: number;
  preFilter?: PreFilter;
  includePatterns: string[];
  excludePatterns: string[];
}

/** Unsupported combinations are rejected before stdin/files can be consumed. */
export function canStreamGrep(input: {
  ctx: RuntimeCommandContext;
  operands: string[];
  patterns: string[];
  patternFiles: string[];
  fixedStrings: boolean;
  ignoreCase: boolean;
  wholeWord: boolean;
  lineRegexp: boolean;
  onlyMatching: boolean;
  perlRegex: boolean;
  beforeContext: number;
  afterContext: number;
  countOnly: boolean;
  quietMode: boolean;
  filesWithMatches: boolean;
  filesWithoutMatch: boolean;
}): boolean {
  if (
    input.onlyMatching ||
    input.perlRegex ||
    input.beforeContext !== 0 ||
    input.afterContext !== 0 ||
    input.patternFiles.includes("-")
  )
    return false;
  const stdin = !input.operands.length || input.operands.includes("-");
  if (
    input.operands.some((path) => path !== "-") &&
    !input.ctx.fs.openByteReader
  )
    return false;
  if (!stdin) return true;
  if (
    !input.operands.length &&
    (input.filesWithMatches || input.filesWithoutMatch)
  )
    return false;
  // Unknown bytes can make the old whole-stdin decoder choose Latin1 late.
  // ASCII fixed summaries have the same selection under either decoding.
  return (
    Boolean(input.ctx.byteIO) &&
    input.fixedStrings &&
    !input.ignoreCase &&
    !input.wholeWord &&
    !input.lineRegexp &&
    (input.countOnly ||
      input.quietMode ||
      Boolean(
        input.operands.length &&
          (input.filesWithMatches || input.filesWithoutMatch),
      )) &&
    input.patterns.every(asciiPattern)
  );
}

export async function streamGrep(
  ctx: RuntimeCommandContext,
  files: StreamFile[],
  regex: UserRegex,
  options: GrepStreamOptions,
): Promise<ExecResult> {
  const output = new GrepOutput(ctx);
  let stderr = "",
    anyError = false,
    anyMatch = false;
  try {
    for (const file of files) {
      if (!file.isStdin && !options.recursive) {
        const basename = file.path.split("/").pop() ?? file.path;
        if (
          options.excludePatterns.some((pattern) =>
            matchGlob(basename, pattern, { stripQuotes: true }),
          ) ||
          (options.includePatterns.length > 0 &&
            !options.includePatterns.some((pattern) =>
              matchGlob(basename, pattern, { stripQuotes: true }),
            ))
        )
          continue;
      }
      let matches = 0;
      try {
        if (file.stdinAtEof) {
          // A repeated '-' sees EOF, even when a previous -m stopped early.
        } else {
          let reader: ByteReader;
          let maximumBytes: number | undefined;
          if (file.isStdin) reader = (ctx.byteIO as CommandByteIO).stdin;
          else {
            const path = ctx.fs.resolvePath(ctx.cwd, file.path);
            const stat =
              file.isFile === false ? undefined : await ctx.fs.stat(path);
            if (!stat || stat.isDirectory) {
              if (!options.recursive)
                stderr += `grep: ${file.path}: Is a directory\n`;
              continue;
            }
            if (stat.size > ctx.limits.maxStringLength)
              throw new ExecutionLimitError(
                "grep: file text size limit exceeded",
                "string_length",
              );
            // Full logical input is admitted before opening or early stopping.
            accountFileInput(ctx, stat.size, "grep");
            maximumBytes = stat.size;
            const open = ctx.fs.openByteReader as NonNullable<
              typeof ctx.fs.openByteReader
            >;
            reader = await open.call(ctx.fs, path);
            if (reader.size !== undefined && reader.size > stat.size) {
              await withByteReader(reader, async () => {
                throw new ExecutionLimitError(
                  "grep: file grew while being read",
                  "string_length",
                );
              });
            }
          }
          const search = async (source: ByteReader) => {
            let lineNumber = 0,
              characters = 0;
            let needsSearch =
              (file.isStdin && file.path === "") ||
              !options.preFilter ||
              options.invertMatch;
            for await (const { value: line, terminated } of grepLines(
              source,
              ctx,
              file.isStdin,
              maximumBytes,
              () => output.flush(),
            )) {
              lineNumber++;
              characters += line.length + Number(terminated);
              const filter = options.preFilter;
              let possible = true;
              if (!options.invertMatch && filter) {
                const haystack = filter.ignoreCase ? line.toLowerCase() : line;
                possible = filter.needles.some((needle) =>
                  haystack.includes(needle),
                );
                needsSearch ||= possible;
              }
              // The buffered implementation bypasses all matching/line-array
              // work when the complete file cannot contain a required literal.
              if (!needsSearch) continue;
              const work = lineNumber + Math.ceil(characters / 1024);
              if (work > options.maxWork)
                throw new ExecutionLimitError(
                  `search: matching work limit exceeded (${options.maxWork})`,
                  "iterations",
                );
              if (lineNumber + Number(terminated) > ctx.limits.maxArrayElements)
                throw new ExecutionLimitError(
                  `search: line limit exceeded (${ctx.limits.maxArrayElements})`,
                  "array_elements",
                );
              if (ctx.signal?.aborted) throw new ExecutionAbortedError();
              // The count-only inner loop in searchContent: same RE2 matcher,
              // literal prefilter and selected-line rule, without per-line
              // count result strings or a whole-file line array.
              if (!possible) continue;
              regex.lastIndex = 0;
              if (regex.test(line) !== options.invertMatch) {
                matches++;
                if (
                  !options.quietMode &&
                  !options.countOnly &&
                  !options.filesWithMatches &&
                  !options.filesWithoutMatch
                ) {
                  await output.append(
                    `${options.showFilename ? `${file.path}:` : ""}${options.showLineNumbers ? `${lineNumber}:` : ""}`,
                  );
                  await output.append(line);
                  await output.append("\n");
                }
                const summary =
                  options.quietMode ||
                  options.filesWithMatches ||
                  options.filesWithoutMatch;
                if (
                  (summary && !options.countOnly) ||
                  (options.maxCount > 0 && matches >= options.maxCount)
                )
                  break;
              }
            }
          };
          if (file.isStdin) await search(reader);
          else await withByteReader(reader, search);
        }
        ctx.executionScope?.throwIfAborted("grep");
        if (ctx.signal?.aborted) throw new ExecutionAbortedError();
        anyMatch ||= matches > 0;
        if (options.quietMode && matches)
          return { stdout: "", stderr: "", exitCode: 0 };
        if (options.quietMode) continue;
        if (
          (matches && options.filesWithMatches) ||
          (!matches && options.filesWithoutMatch)
        )
          await output.append(`${file.path}\n`);
        else if (
          options.countOnly &&
          !options.filesWithMatches &&
          (matches ? !options.filesWithoutMatch : true)
        )
          await output.append(
            `${options.showFilename ? `${file.path}:` : ""}${matches}\n`,
          );
      } catch (error) {
        rethrowFatalExecutionError(error);
        if (ctx.signal?.aborted) throw new ExecutionAbortedError();
        stderr += `grep: ${file.path}: ${fsErrorMessage(error)}\n`;
        anyError = true;
      }
    }
    return {
      stdout: await output.finish(),
      stderr: options.quietMode ? "" : stderr,
      exitCode: anyError ? 2 : anyMatch ? 0 : 1,
    };
  } finally {
    output.close();
  }
}
