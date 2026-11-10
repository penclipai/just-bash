import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import type { DirentEntry, SnapshotTreeEntry } from "../../fs/interface.js";
import type { RuntimeCommandContext } from "../../types.js";
import { matchGlob } from "../../utils/glob.js";
import {
  addTraversalResult,
  expandGlobPatternWithTypes,
  type FileEntry,
  type GrepTraversalBudget,
  MAX_GREP_DEPTH,
  useTraversalOperation,
} from "./grep-globs.js";

interface Options {
  recursive: boolean;
  followLinks: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  excludeDirPatterns: string[];
  noFilename: boolean;
  stdinUsedForPatterns: boolean;
  quietMode: boolean;
}

function matches(name: string, patterns: string[]) {
  return patterns.some((pattern) =>
    matchGlob(name, pattern, { stripQuotes: true }),
  );
}

function included(name: string, options: Options) {
  return (
    !matches(name, options.excludePatterns) &&
    (!options.includePatterns.length || matches(name, options.includePatterns))
  );
}

const childPath = (parent: string, name: string) =>
  `${parent.replace(/\/+$/, "")}/${name}`;
const basename = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1) || path;

function* snapshotFiles(
  entries: SnapshotTreeEntry[],
  root: string,
  options: Options,
  budget: GrepTraversalBudget,
): Generator<FileEntry> {
  const directories: string[] = [];
  let skipped = Infinity;
  for (const [depth, name, kind] of entries) {
    if (depth > skipped || depth >= MAX_GREP_DEPTH) continue;
    skipped = Infinity;
    useTraversalOperation(budget);
    const file = depth ? childPath(directories[depth - 1], name) : root;
    const base = depth ? name : basename(root);
    if (kind === "d") {
      if (matches(base, options.excludeDirPatterns)) skipped = depth;
      else {
        directories[depth] = file;
        useTraversalOperation(budget);
      }
    } else if (kind === "f" && included(base, options)) {
      addTraversalResult(budget);
      yield { path: file, isFile: true };
    }
  }
}

async function* liveFiles(
  ctx: RuntimeCommandContext,
  root: string,
  options: Options,
  budget: GrepTraversalBudget,
): AsyncGenerator<FileEntry> {
  type Frame = {
    prefix: string;
    physical?: string;
    entries: (string | DirentEntry)[];
    next: number;
  };
  const dirs: Frame[] = [];
  let file = root;
  let entry: DirentEntry | undefined;
  while (true) {
    const depth = dirs.length;
    const full = ctx.fs.resolvePath(ctx.cwd, file);
    const base = basename(file);
    try {
      useTraversalOperation(budget);
      if (depth < MAX_GREP_DEPTH) {
        const stat =
          !entry || (entry.isSymbolicLink && options.followLinks)
            ? depth && !options.followLinks
              ? await ctx.fs.lstat(full)
              : await ctx.fs.stat(full)
            : entry;
        if (stat.isFile && included(base, options)) {
          addTraversalResult(budget);
          yield { path: file, isFile: true };
        } else if (
          stat.isDirectory &&
          !matches(base, options.excludeDirPatterns)
        ) {
          useTraversalOperation(budget);
          // -R follows links, but a repeated ancestor is a cycle. A sibling
          // alias to the same directory remains a separate traversal.
          const physical = options.followLinks
            ? await ctx.fs.realpath(full)
            : undefined;
          if (
            physical !== undefined &&
            dirs.some((d) => d.physical === physical)
          ) {
            yield {
              path: file,
              warning: `grep: ${file}: warning: recursive directory loop\n`,
            };
          } else {
            const entries = ctx.fs.readdirWithFileTypes
              ? await ctx.fs.readdirWithFileTypes(full)
              : await ctx.fs.readdir(full);
            dirs.push({
              prefix: `${file.replace(/\/+$/, "")}/`,
              physical,
              entries,
              next: 0,
            });
          }
        }
      }
    } catch (error) {
      rethrowFatalExecutionError(error);
      // Preserve the recursive expander's handling of unavailable entries.
    }
    while (
      dirs.length &&
      dirs[dirs.length - 1].next >= dirs[dirs.length - 1].entries.length
    )
      dirs.pop();
    const current = dirs[dirs.length - 1];
    if (!current) return;
    const child = current.entries[current.next++];
    entry = typeof child === "string" ? undefined : child;
    file = current.prefix + (typeof child === "string" ? child : child.name);
  }
}

async function* operands(
  ctx: RuntimeCommandContext,
  files: string[],
  options: Options,
  budget: GrepTraversalBudget,
) {
  let stdinConsumed = options.stdinUsedForPatterns;
  for (const path of files) {
    if (path === "-") {
      addTraversalResult(budget);
      yield {
        path: "(standard input)",
        isFile: true,
        isStdin: true,
        stdinAtEof: stdinConsumed,
      };
      stdinConsumed = true;
      continue;
    }
    const glob = /[*?[]/.test(path);
    const roots = glob
      ? await expandGlobPatternWithTypes(path, ctx, budget)
      : [{ path }];
    for (const root of roots) {
      if (!options.recursive) {
        if (!glob) addTraversalResult(budget);
        yield root;
        continue;
      }
      const listing =
        !options.followLinks && ctx.fs.readSnapshotTree
          ? await ctx.fs.readSnapshotTree(
              ctx.fs.resolvePath(ctx.cwd, root.path),
              MAX_GREP_DEPTH - 1,
              true,
            )
          : undefined;
      if (listing !== undefined) {
        const rows: SnapshotTreeEntry[] = JSON.parse(listing);
        // GNU -r follows a symlink named explicitly on the command line.
        if (rows[0]?.[2] !== "l") {
          yield* snapshotFiles(rows, root.path, options, budget);
          continue;
        }
      }
      yield* liveFiles(ctx, root.path, options, budget);
    }
  }
}

async function* readBatches(
  files: AsyncIterable<FileEntry> | Iterable<FileEntry>,
  prefix: boolean,
) {
  // Start consuming right at the first result. Grow read-ahead only while
  // the consumer still needs more lines; an unbounded search keeps 50 lanes.
  let limit = prefix ? 1 : 50;
  let batch: FileEntry[] = [];
  for await (const file of files) {
    batch.push(file);
    if (batch.length >= limit) {
      yield batch;
      batch = [];
      limit = Math.min(50, limit * 2);
    }
  }
  if (batch.length) yield batch;
}

export async function grepFileBatches(
  ctx: RuntimeCommandContext,
  files: string[],
  options: Options,
): Promise<{ batches: AsyncGenerator<FileEntry[]>; showFilename: boolean }> {
  const budget: GrepTraversalBudget = {
    operations: 0,
    results: 0,
    maxOperations: ctx.limits.maxGlobOperations,
    maxResults: ctx.limits.maxArrayElements,
  };
  const names = operands(ctx, files, options, budget);
  const prefix = !!ctx.stdoutLimit || options.quietMode;
  if (options.recursive) {
    return {
      batches: readBatches(names, prefix),
      showFilename:
        !options.noFilename &&
        (files.length > 1 || files.some((f) => f !== "-")),
    };
  }
  // Non-recursive glob expansion determines whether GNU prefixes one or
  // several filenames. Finish that expansion before selecting the formatter.
  const expanded: FileEntry[] = [];
  for await (const entry of names) expanded.push(entry);
  return {
    batches: readBatches(expanded, prefix),
    showFilename: !options.noFilename && expanded.length > 1,
  };
}
