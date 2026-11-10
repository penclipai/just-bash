import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import { matchGlob } from "../../utils/glob.js";

/** File entry with optional type info from glob expansion */
export interface FileEntry {
  path: string;
  warning?: string;
  isFile?: boolean; // undefined means we need to stat
  /** True for the `-` operand, which names standard input instead of a file. */
  isStdin?: boolean;
  /**
   * True when an earlier `-` already drained stdin. stdin is a stream, so the
   * second `-` of `grep pat - -` reads EOF and contributes nothing.
   */
  stdinAtEof?: boolean;
}

export interface GrepTraversalBudget {
  operations: number;
  results: number;
  maxOperations: number;
  maxResults: number;
}

export function useTraversalOperation(budget: GrepTraversalBudget): void {
  if (++budget.operations > budget.maxOperations) {
    throw new ExecutionLimitError(
      `grep: glob operation limit exceeded (${budget.maxOperations})`,
      "glob_operations",
    );
  }
}

export function addTraversalResult(budget: GrepTraversalBudget): void {
  if (budget.results >= budget.maxResults) {
    throw new ExecutionLimitError(
      `grep: array element limit exceeded (${budget.maxResults})`,
      "array_elements",
    );
  }
  budget.results++;
}

/** Safety limit to prevent stack overflow on deeply nested directories */
export const MAX_GREP_DEPTH = 256;

async function expandRecursiveGlob(
  baseDir: string,
  afterGlob: string,
  ctx: RuntimeCommandContext,
  result: string[],
  budget: GrepTraversalBudget,
  depth = 0,
): Promise<void> {
  if (depth >= MAX_GREP_DEPTH) return;
  const fullBasePath = ctx.fs.resolvePath(ctx.cwd, baseDir);

  try {
    useTraversalOperation(budget);
    const stat = await ctx.fs.stat(fullBasePath);

    if (!stat.isDirectory) {
      // Check if the file matches afterGlob pattern
      const filename = baseDir.split("/").pop() || "";
      if (afterGlob) {
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(filename, pattern, { stripQuotes: true })) {
          addTraversalResult(budget);
          result.push(baseDir);
        }
      }
      return;
    }

    // Check files in current directory
    useTraversalOperation(budget);
    const entries = await ctx.fs.readdir(fullBasePath);
    for (const entry of entries) {
      const entryPath = baseDir === "." ? entry : `${baseDir}/${entry}`;
      const fullEntryPath = ctx.fs.resolvePath(ctx.cwd, entryPath);
      useTraversalOperation(budget);
      const entryStat = await ctx.fs.stat(fullEntryPath);

      if (entryStat.isDirectory) {
        // Recurse into directory
        await expandRecursiveGlob(
          entryPath,
          afterGlob,
          ctx,
          result,
          budget,
          depth + 1,
        );
      } else if (afterGlob) {
        // Check if file matches afterGlob pattern
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(entry, pattern, { stripQuotes: true })) {
          addTraversalResult(budget);
          result.push(entryPath);
        }
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Ignore errors
  }
}

/**
 * Optimized glob expansion that returns FileEntry with type info
 * Uses readdirWithFileTypes when available to avoid stat calls
 */
export async function expandGlobPatternWithTypes(
  pattern: string,
  ctx: RuntimeCommandContext,
  budget: GrepTraversalBudget,
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Find the directory part and the glob part
  const lastSlash = pattern.lastIndexOf("/");
  let dirPath: string;
  let globPart: string;

  if (lastSlash === -1) {
    dirPath = ctx.cwd;
    globPart = pattern;
  } else {
    dirPath = pattern.slice(0, lastSlash) || "/";
    globPart = pattern.slice(lastSlash + 1);
  }

  // Handle ** (recursive glob) - fall back to old method
  if (pattern.includes("**")) {
    const oldResult: string[] = [];
    const parts = pattern.split("**");
    const baseDir = parts[0].replace(/\/$/, "") || ".";
    const afterGlob = parts[1] || "";
    await expandRecursiveGlob(baseDir, afterGlob, ctx, oldResult, budget);
    return oldResult.map((p) => ({ path: p }));
  }

  // Resolve the directory path
  const fullDirPath = ctx.fs.resolvePath(ctx.cwd, dirPath);

  try {
    // Use readdirWithFileTypes if available for better performance
    if (ctx.fs.readdirWithFileTypes) {
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdirWithFileTypes(fullDirPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (matchGlob(entry.name, globPart, { stripQuotes: true })) {
          const fullPath =
            lastSlash === -1 ? entry.name : `${dirPath}/${entry.name}`;
          addTraversalResult(budget);
          result.push({
            path: fullPath,
            isFile: entry.isFile,
          });
        }
      }
    } else {
      // Fall back to regular readdir
      useTraversalOperation(budget);
      const entries = await ctx.fs.readdir(fullDirPath);
      for (const entry of entries) {
        useTraversalOperation(budget);
        if (matchGlob(entry, globPart, { stripQuotes: true })) {
          const fullPath = lastSlash === -1 ? entry : `${dirPath}/${entry}`;
          addTraversalResult(budget);
          result.push({ path: fullPath });
        }
      }
    }
  } catch (error) {
    rethrowFatalExecutionError(error);
    // Directory doesn't exist - return empty
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}
