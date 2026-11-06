import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { hasHelpFlag, showHelp } from "../help.js";
import { readWcCounts } from "./read-counts.js";

const wcHelp = {
  name: "wc",
  summary: "print newline, word, and byte counts for each file",
  usage: "wc [OPTION]... [FILE]...",
  options: [
    "-c, --bytes      print the byte counts",
    "-m, --chars      print the character counts",
    "-l, --lines      print the newline counts",
    "-w, --words      print the word counts",
    "    --help       display this help and exit",
  ],
};

const argDefs = {
  lines: { short: "l", long: "lines", type: "boolean" as const },
  words: { short: "w", long: "words", type: "boolean" as const },
  bytes: { short: "c", long: "bytes", type: "boolean" as const },
  chars: { short: "m", long: "chars", type: "boolean" as const },
};

export const wcCommand: RuntimeCommand = {
  name: "wc",

  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(wcHelp);
    }

    const parsed = parseArgs("wc", args, argDefs);
    if (!parsed.ok) return parsed.error;

    let { lines: showLines, words: showWords } = parsed.result.flags;
    let showBytes = parsed.result.flags.bytes;
    const showChars = parsed.result.flags.chars;
    const files = parsed.result.positional;

    // If no flags specified, default to lines + words + bytes (-c).
    if (!showLines && !showWords && !showBytes && !showChars) {
      showLines = showWords = showBytes = true;
    }
    // The third column is either bytes or chars, depending on flag.
    const showThird = showBytes || showChars;

    // Read files
    const readResult = await readWcCounts(ctx, files, {
      lines: showLines,
      words: showWords,
      chars: showChars,
    });

    // If reading from stdin (no files), use simpler output
    if (files.length === 0) {
      if (!readResult.files.length)
        return {
          stdout: "",
          stderr: readResult.stderr,
          exitCode: readResult.exitCode,
        };
      const stats = readResult.files[0].stats;
      return {
        stdout: `${formatStats(stats, showLines, showWords, showThird, "", 0)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // First pass: count stats for all files and calculate max widths
    const allStats: Array<{
      filename: string;
      stats: { lines: number; words: number; third: number };
    }> = [];
    let totalLines = 0;
    let totalWords = 0;
    let totalThird = 0;

    for (const { filename, stats } of readResult.files) {
      totalLines += stats.lines;
      totalWords += stats.words;
      totalThird += stats.third;
      allStats.push({ filename, stats });
    }

    // GNU uses the width of the combined regular-file byte size, even when
    // printing only lines/words. A single selected count needs no padding.
    let maxWidth =
      files.length === 1 &&
      Number(showLines) + Number(showWords) + Number(showThird) === 1
        ? 0
        : 1;
    if (files.length > 1 || maxWidth > 0) {
      let totalBytes = 0;
      for (const file of readResult.files) totalBytes += file.stats.bytes;
      maxWidth = Math.max(maxWidth, String(totalBytes).length);
    }

    // Second pass: format output with proper alignment
    let stdout = "";
    for (const { filename, stats } of allStats) {
      stdout += `${formatStats(stats, showLines, showWords, showThird, filename, maxWidth)}\n`;
    }

    // Show total for multiple files
    if (files.length > 1) {
      stdout += `${formatStats(
        { lines: totalLines, words: totalWords, third: totalThird },
        showLines,
        showWords,
        showThird,
        "total",
        maxWidth,
      )}\n`;
    }

    return { stdout, stderr: readResult.stderr, exitCode: readResult.exitCode };
  },
};

function formatStats(
  stats: { lines: number; words: number; third: number },
  showLines: boolean,
  showWords: boolean,
  showThird: boolean,
  filename: string,
  minWidth: number,
): string {
  const values: string[] = [];
  if (showLines) {
    values.push(String(stats.lines).padStart(minWidth));
  }
  if (showWords) {
    values.push(String(stats.words).padStart(minWidth));
  }
  if (showThird) {
    values.push(String(stats.third).padStart(minWidth));
  }

  let result = values.join(" ");
  if (filename) {
    result += ` ${filename}`;
  }

  return result;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "wc",
  flags: [
    { flag: "-l", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-m", type: "boolean" },
  ],
  stdinType: "text",
  needsFiles: true,
};
