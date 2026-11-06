import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { ExecutionLimits } from "../../limits.js";
import {
  assertDefenseContext,
  awaitWithDefenseContext,
} from "../../security/defense-context.js";
import type {
  FeatureCoverageWriter,
  RuntimeCommandContext,
} from "../../types.js";
import {
  createInitialState,
  type ExecuteContext,
  executeCommands,
} from "./executor.js";
import { createSedLineSource, needsLastLine } from "./line-source.js";
import type {
  RangeState,
  SedCommand,
  SedExecutionLimits,
  SedState,
} from "./types.js";

export interface ProcessContentOptions {
  limits?: Required<ExecutionLimits>;
  lineNumberOffset?: number;
  filename?: string;
  fs?: RuntimeCommandContext["fs"];
  cwd?: string;
  coverage?: FeatureCoverageWriter;
  requireDefenseContext?: boolean;
}

export async function processContent(
  content: string,
  commands: SedCommand[],
  silent: boolean,
  options: ProcessContentOptions = {},
): Promise<{ output: string; exitCode?: number; errorMessage?: string }> {
  const { limits, filename, fs, cwd, coverage, requireDefenseContext } =
    options;
  assertDefenseContext(requireDefenseContext, "sed", "processing entry");
  const withDefenseContext = <T>(
    phase: string,
    op: () => Promise<T>,
  ): Promise<T> =>
    awaitWithDefenseContext(requireDefenseContext, "sed", phase, op);

  // Track if input ended with newline - needed for preserving trailing newline behavior
  const inputEndsWithNewline = content.endsWith("\n");

  const lines = createSedLineSource(content);
  const totalLines = needsLastLine(commands)
    ? lines.count()
    : Number.MAX_SAFE_INTEGER;
  let output = "";
  let exitCode: number | undefined;
  // Track if the last output came from auto-print (to determine trailing newline behavior)
  // Only auto-print should have its trailing newline stripped when input has no trailing newline
  let lastOutputWasAutoPrint = false;

  // Extract max output size from limits
  const maxOutputSize = limits?.maxStringLength ?? 0;
  const appendOutput = (text: string): void => {
    output += text;
    if (maxOutputSize > 0 && output.length > maxOutputSize) {
      throw new ExecutionLimitError(
        `sed: output size limit exceeded (${maxOutputSize} bytes)`,
        "string_length",
      );
    }
  };

  // Persistent state across all lines
  let holdSpace = "";
  let lastPattern: string | undefined;
  const rangeStates = new Map<string, RangeState>();

  // For file I/O: track line positions for R command, accumulate writes
  const fileLineCache = new Map<string, string[]>();
  const fileLinePositions = new Map<string, number>();
  const fileWrites = new Map<string, string>();

  // Convert to SedExecutionLimits format
  const sedLimits: SedExecutionLimits | undefined = limits
    ? {
        maxIterations: limits.maxSedIterations,
        maxStringLength: maxOutputSize,
      }
    : undefined;

  for (let lineIndex = 0; lines.has(lineIndex); lineIndex++) {
    const state: SedState = {
      ...createInitialState(totalLines, filename, rangeStates),
      patternSpace: lines.get(lineIndex),
      holdSpace: holdSpace,
      lastPattern: lastPattern,
      lineNumber: lineIndex + 1 + (options.lineNumberOffset ?? 0),
      totalLines,
      substitutionMade: false, // Reset for each new line (T command behavior)
      coverage,
    };

    // Create execution context for N command
    const ctx: ExecuteContext = {
      lines,
      currentLineIndex: lineIndex,
    };

    // Execute commands with support for D command cycle restart
    let cycleIterations = 0;
    const maxCycleIterations = 10000;
    // Reset lines consumed counter for this cycle
    state.linesConsumedInCycle = 0;
    do {
      cycleIterations++;
      if (cycleIterations > maxCycleIterations) {
        // Prevent infinite loops
        break;
      }

      state.restartCycle = false;
      state.pendingFileReads = [];
      state.pendingFileWrites = [];

      // Execute commands - lines consumed are tracked in state.linesConsumedInCycle
      executeCommands(commands, state, ctx, sedLimits);

      // Process pending file reads
      if (fs && cwd) {
        for (const read of state.pendingFileReads) {
          const filePath = fs.resolvePath(cwd, read.filename);
          try {
            if (read.wholeFile) {
              // r command - read entire file, append after current line
              const fileContent = await withDefenseContext(
                "read command file",
                () => fs.readFile(filePath),
              );
              state.appendBuffer.push(fileContent.replace(/\n$/, ""));
            } else {
              // R command - read one line from file
              if (!fileLineCache.has(filePath)) {
                const fileContent = await withDefenseContext(
                  "read command file line cache",
                  () => fs.readFile(filePath),
                );
                fileLineCache.set(filePath, fileContent.split("\n"));
                fileLinePositions.set(filePath, 0);
              }
              const fileLines = fileLineCache.get(filePath);
              const pos = fileLinePositions.get(filePath);
              if (fileLines && pos !== undefined && pos < fileLines.length) {
                state.appendBuffer.push(fileLines[pos]);
                fileLinePositions.set(filePath, pos + 1);
              }
            }
          } catch (e) {
            rethrowFatalExecutionError(e);
            // File not found - silently ignore (matches GNU sed behavior)
          }
        }

        // Accumulate file writes
        for (const write of state.pendingFileWrites) {
          const filePath = fs.resolvePath(cwd, write.filename);
          const existing = fileWrites.get(filePath) || "";
          fileWrites.set(filePath, existing + write.content);
        }
      }
    } while (
      state.restartCycle &&
      !state.deleted &&
      !state.quit &&
      !state.quitSilent
    );

    // Update main line index with total lines consumed during this cycle
    lineIndex += state.linesConsumedInCycle;

    // Preserve state for next line
    holdSpace = state.holdSpace;
    lastPattern = state.lastPattern;

    // Output from n command (respects silent mode) - must come before other outputs
    if (!silent) {
      for (const ln of state.nCommandOutput) {
        appendOutput(`${ln}\n`);
      }
    }

    // Output line numbers from = command (and l, F commands, p command)
    const hadLineNumberOutput = state.lineNumberOutput.length > 0;
    for (const ln of state.lineNumberOutput) {
      appendOutput(`${ln}\n`);
    }

    // Handle insert commands (marked with __INSERT__ prefix)
    const inserts: string[] = [];
    const appends: string[] = [];
    for (const item of state.appendBuffer) {
      if (item.startsWith("__INSERT__")) {
        inserts.push(item.slice(10));
      } else {
        appends.push(item);
      }
    }

    // Output inserts before the line
    for (const text of inserts) {
      appendOutput(`${text}\n`);
    }

    // Handle output - Q (quitSilent) suppresses the final print
    // Track whether output came from auto-print or explicit print (for trailing newline handling)
    let hadPatternSpaceOutput = false;
    if (!state.deleted && !state.quitSilent) {
      if (silent) {
        if (state.printed) {
          appendOutput(`${state.patternSpace}\n`);
          hadPatternSpaceOutput = true; // Explicit print in silent mode
        }
      } else {
        appendOutput(`${state.patternSpace}\n`);
        hadPatternSpaceOutput = true; // Auto-print in non-silent mode
      }
    } else if (state.changedText !== undefined) {
      // c command: output changed text in place of pattern space
      appendOutput(`${state.changedText}\n`);
      hadPatternSpaceOutput = true;
    }

    // Output appends after the line
    for (const text of appends) {
      appendOutput(`${text}\n`);
    }

    // Track if this line produced output that should have trailing newline stripped
    // This includes: explicit print (lineNumberOutput from p command or /p flag),
    // pattern space output (auto-print or explicit via state.printed), but NOT appends
    const hadOutput = hadLineNumberOutput || hadPatternSpaceOutput;
    lastOutputWasAutoPrint = hadOutput && appends.length === 0;

    // Check for quit commands or errors
    if (state.quit || state.quitSilent) {
      if (state.exitCode !== undefined) {
        exitCode = state.exitCode;
      }
      if (state.errorMessage) {
        // Early exit on error
        return {
          output: "",
          exitCode: exitCode || 1,
          errorMessage: state.errorMessage,
        };
      }
      break;
    }
  }

  // Flush all accumulated file writes at end
  if (fs && cwd) {
    for (const [filePath, fileContent] of fileWrites) {
      try {
        await withDefenseContext("flush pending file writes", () =>
          fs.writeFile(filePath, fileContent),
        );
      } catch (e) {
        rethrowFatalExecutionError(e);
        // Write error - silently ignore for now
      }
    }
  }

  // If input didn't end with newline, strip trailing newline from output
  // BUT only if the last output was from auto-print (non-silent mode, no explicit prints/appends)
  if (
    !inputEndsWithNewline &&
    lastOutputWasAutoPrint &&
    output.endsWith("\n")
  ) {
    output = output.slice(0, -1);
  }

  return { output, exitCode };
}
