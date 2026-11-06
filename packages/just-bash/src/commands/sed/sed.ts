// Automa modifications: N00b source migration of shell compatibility patches.
import { decodeBytesToUtf8 } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionAbortedError } from "../../interpreter/errors.js";
import {
  assertDefenseContext,
  awaitWithDefenseContext,
} from "../../security/defense-context.js";
import type {
  ExecResult,
  RuntimeCommand,
  RuntimeCommandContext,
} from "../../types.js";
import { fsErrorMessage } from "../../utils/fs-error.js";
import { readStdin } from "../../utils/read-stdin.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";
import { parseMultipleScripts } from "./parser.js";
import { processContent } from "./process-content.js";
import { canStreamSed, streamSedFile } from "./stream-sed.js";

const sedHelp = {
  name: "sed",
  summary: "stream editor for filtering and transforming text",
  usage: "sed [OPTION]... {script} [input-file]...",
  options: [
    "-n, --quiet, --silent  suppress automatic printing of pattern space",
    "-e script              add the script to commands to be executed",
    "-f script-file         read script from file",
    "-i, --in-place         edit files in place",
    "-E, -r, --regexp-extended  use extended regular expressions",
    "    --help             display this help and exit",
  ],
  description: `Commands:
  s/regexp/replacement/[flags]  substitute
  d                             delete pattern space
  p                             print pattern space
  a\\ text                       append text after line
  i\\ text                       insert text before line
  c\\ text                       change (replace) line with text
  h                             copy pattern space to hold space
  H                             append pattern space to hold space
  g                             copy hold space to pattern space
  G                             append hold space to pattern space
  x                             exchange pattern and hold spaces
  n                             read next line into pattern space
  N                             append next line to pattern space
  y/source/dest/                transliterate characters
  =                             print line number
  l                             list pattern space (escape special chars)
  b [label]                     branch to label
  t [label]                     branch on substitution
  T [label]                     branch if no substitution
  :label                        define label
  q                             quit
  Q                             quit without printing

Addresses:
  N                             line number
  $                             last line
  /regexp/                      lines matching regexp
  N,M                           range from line N to M
  first~step                    every step-th line starting at first`,
};

export const sedCommand: RuntimeCommand = {
  name: "sed",
  async execute(
    args: string[],
    ctx: RuntimeCommandContext,
  ): Promise<ExecResult> {
    assertDefenseContext(ctx.requireDefenseContext, "sed", "execution entry");
    const withDefenseContext = <T>(
      phase: string,
      op: () => Promise<T>,
    ): Promise<T> =>
      awaitWithDefenseContext(ctx.requireDefenseContext, "sed", phase, op);

    if (hasHelpFlag(args)) {
      return showHelp(sedHelp);
    }

    const scripts: string[] = [];
    const scriptFiles: string[] = [];
    let silent = false;
    let inPlace = false;
    let backupSuffix = "";
    let extendedRegex = false;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-n" || arg === "--quiet" || arg === "--silent") {
        silent = true;
      } else if (arg === "-i" || arg === "--in-place") {
        inPlace = true;
        backupSuffix = "";
      } else if (arg.startsWith("-i") || arg.startsWith("--in-place=")) {
        inPlace = true;
        backupSuffix = arg.startsWith("-i") ? arg.slice(2) : arg.slice(11);
      } else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") {
        extendedRegex = true;
      } else if (arg === "-e") {
        if (i + 1 < args.length) {
          scripts.push(args[++i]);
        }
      } else if (arg === "-f") {
        if (i + 1 < args.length) {
          scriptFiles.push(args[++i]);
        }
      } else if (arg.startsWith("--")) {
        return unknownOption("sed", arg);
      } else if (arg === "-") {
        // "-" is stdin marker, treat as a file
        files.push(arg);
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const c of arg.slice(1)) {
          if (
            c !== "n" &&
            c !== "e" &&
            c !== "f" &&
            c !== "i" &&
            c !== "E" &&
            c !== "r"
          ) {
            return unknownOption("sed", `-${c}`);
          }
        }
        if (arg.includes("n")) silent = true;
        if (arg.includes("i")) inPlace = true;
        if (arg.includes("E") || arg.includes("r")) extendedRegex = true;
        if (arg.includes("e") && !arg.includes("n") && !arg.includes("i")) {
          if (i + 1 < args.length) {
            scripts.push(args[++i]);
          }
        }
        if (arg.includes("f") && !arg.includes("e")) {
          if (i + 1 < args.length) {
            scriptFiles.push(args[++i]);
          }
        }
      } else if (
        !arg.startsWith("-") &&
        scripts.length === 0 &&
        scriptFiles.length === 0
      ) {
        scripts.push(arg);
      } else if (!arg.startsWith("-")) {
        files.push(arg);
      }
    }

    // Read scripts from -f files
    for (const scriptFile of scriptFiles) {
      const scriptPath = ctx.fs.resolvePath(ctx.cwd, scriptFile);
      try {
        const scriptContent = await withDefenseContext("script file read", () =>
          ctx.fs.readFile(scriptPath),
        );
        // Split by newlines and add each line as a separate script
        for (const line of scriptContent.split("\n")) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            scripts.push(trimmed);
          }
        }
      } catch (e) {
        rethrowFatalExecutionError(e);
        return {
          stdout: "",
          stderr: `sed: couldn't open file ${scriptFile}: No such file or directory\n`,
          exitCode: 1,
        };
      }
    }

    if (scripts.length === 0) {
      return {
        stdout: "",
        stderr: "sed: no script specified\n",
        exitCode: 1,
      };
    }

    // Parse all scripts
    const { commands, error, silentMode } = parseMultipleScripts(
      scripts,
      extendedRegex,
      ctx.limits,
    );
    if (error) {
      return {
        stdout: "",
        stderr: `sed: ${error}\n`,
        exitCode: 1,
      };
    }

    // Note: empty script (no commands) is valid in sed - just passes through input

    // Enable silent mode from -n flag or #n comment
    const effectiveSilent = !!(silent || silentMode);

    // Handle in-place editing - check this first because -i requires files
    if (inPlace) {
      // -i requires at least one file argument
      if (files.length === 0) {
        return {
          stdout: "",
          stderr: "sed: -i requires at least one file argument\n",
          exitCode: 1,
        };
      }
      for (const file of files) {
        // Skip "-" for in-place editing (can't edit stdin in-place)
        if (file === "-") {
          continue;
        }
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          const fileContent = await withDefenseContext(
            "in-place input read",
            () => ctx.fs.readFile(filePath),
          );
          const result = await withDefenseContext("in-place processing", () =>
            processContent(fileContent, commands, effectiveSilent, {
              limits: ctx.limits,
              filename: file,
              fs: ctx.fs,
              cwd: ctx.cwd,
              coverage: ctx.coverage,
              requireDefenseContext: ctx.requireDefenseContext,
            }),
          );
          if (result.errorMessage) {
            return {
              stdout: "",
              stderr: `${result.errorMessage}\n`,
              exitCode: result.exitCode ?? 1,
            };
          }
          if (backupSuffix) {
            const backup = backupSuffix.includes("*")
              ? backupSuffix.replaceAll("*", file)
              : file + backupSuffix;
            const backupPath = ctx.fs.resolvePath(ctx.cwd, backup);
            const original = await withDefenseContext(
              "in-place backup input read",
              () => ctx.fs.readFileBuffer(filePath),
            );
            let symlink = false;
            try {
              symlink = (
                await withDefenseContext("in-place backup stat", () =>
                  ctx.fs.lstat(backupPath),
                )
              ).isSymbolicLink;
            } catch (error) {
              rethrowFatalExecutionError(error);
              const missing =
                error instanceof Error &&
                (("code" in error && error.code === "ENOENT") ||
                  error.message.startsWith("ENOENT"));
              if (!missing) throw error;
            }
            if (symlink)
              await withDefenseContext("in-place backup unlink", () =>
                ctx.fs.rm(backupPath),
              );
            await withDefenseContext("in-place backup write", () =>
              ctx.fs.writeFile(backupPath, original),
            );
          }
          await withDefenseContext("in-place output write", () =>
            ctx.fs.writeFile(filePath, result.output),
          );
        } catch (e) {
          rethrowFatalExecutionError(e);

          return {
            stdout: "",
            stderr: `sed: ${file}: No such file or directory\n`,
            exitCode: 1,
          };
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    if (canStreamSed(ctx, files, commands)) {
      try {
        return await withDefenseContext("stream input", () =>
          streamSedFile(ctx, files[0], commands, effectiveSilent),
        );
      } catch (error) {
        rethrowFatalExecutionError(error);
        ctx.executionScope?.throwIfAborted("sed");
        if (ctx.signal?.aborted) throw new ExecutionAbortedError();
        return {
          stdout: "",
          stderr: `sed: ${files[0]}: ${fsErrorMessage(error)}\n`,
          exitCode: 1,
        };
      }
    }

    let content = "";

    // Read from files or stdin. sed runs regex over text — decode bytes to
    // UTF-8 so multibyte sequences match as single chars rather than several
    // latin1 bytes.
    if (files.length === 0) {
      content = decodeBytesToUtf8(
        await withDefenseContext("stdin read", () => readStdin(ctx)),
      );
      const result = await withDefenseContext("stdin processing", () =>
        processContent(content, commands, effectiveSilent, {
          limits: ctx.limits,
          fs: ctx.fs,
          cwd: ctx.cwd,
          coverage: ctx.coverage,
          requireDefenseContext: ctx.requireDefenseContext,
        }),
      );
      // sed emits text; the pipeline handles encoding.
      return {
        stdout: result.output,
        stderr: result.errorMessage ? `${result.errorMessage}\n` : "",
        exitCode: result.exitCode ?? 0,
      };
    }

    // Read all files and process
    // Support "-" as stdin marker
    let stdinConsumed = false;
    for (const file of files) {
      let fileContent: string;
      if (file === "-") {
        // "-" means read from stdin (can only be consumed once)
        if (stdinConsumed) {
          fileContent = "";
        } else {
          fileContent = decodeBytesToUtf8(
            await withDefenseContext("stdin read", () => readStdin(ctx)),
          );
          stdinConsumed = true;
        }
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          fileContent = await withDefenseContext("input file read", () =>
            ctx.fs.readFile(filePath),
          );
        } catch (e) {
          rethrowFatalExecutionError(e);

          return {
            stdout: "",
            stderr: `sed: ${file}: No such file or directory\n`,
            exitCode: 1,
          };
        }
      }
      // When concatenating files, ensure previous content ends with newline
      // (unless this is the first file, previous content is empty, or new content is empty)
      if (
        content.length > 0 &&
        fileContent.length > 0 &&
        !content.endsWith("\n")
      ) {
        content += "\n";
      }
      content += fileContent;
    }

    const result = await withDefenseContext("final processing", () =>
      processContent(content, commands, effectiveSilent, {
        limits: ctx.limits,
        filename: files.length === 1 ? files[0] : undefined,
        fs: ctx.fs,
        cwd: ctx.cwd,
        coverage: ctx.coverage,
        requireDefenseContext: ctx.requireDefenseContext,
      }),
    );
    return {
      stdout: result.output,
      stderr: result.errorMessage ? `${result.errorMessage}\n` : "",
      exitCode: result.exitCode ?? 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "sed",
  flags: [
    { flag: "-n", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-E", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-e", type: "value", valueHint: "string" },
  ],
  stdinType: "text",
  needsArgs: true,
};
