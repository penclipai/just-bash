import type { ExecutionScope } from "../../execution-scope.js";
import type { SnapshotTreeEntry } from "../../fs/interface.js";
import type { FileTraversalBudget } from "../../fs/traversal.js";
import type { RuntimeCommandContext } from "../../types.js";
import { evaluateSimpleExpression } from "./matcher.js";
import type { Expression } from "./types.js";

interface WalkOptions {
  minDepth: number;
  maxDepth: number;
  depthFirst: boolean;
  traversalBudget: FileTraversalBudget;
  appendStdout(text: string): void;
}

/** Find's implicit print path for a complete, readable physical tree. */
export async function printSnapshotTree(
  ctx: RuntimeCommandContext,
  searchPath: string,
  expr: Expression | null,
  options: WalkOptions,
): Promise<boolean> {
  const start =
    searchPath.length > 1 && searchPath.endsWith("/")
      ? searchPath.slice(0, -1)
      : searchPath;
  const listing = await ctx.fs.readSnapshotTree?.(
    ctx.fs.resolvePath(ctx.cwd, start),
  );
  if (listing === undefined) return false;
  const entries: SnapshotTreeEntry[] = JSON.parse(listing);

  // Bounded text segments avoid making every filename its own pipeline
  // segment. Near the cap append complete records separately, preserving
  // find's exact partial output on overflow even for multibyte names.
  const scope = ctx.executionScope as ExecutionScope | undefined;
  const remaining = () =>
    ctx.limits.maxOutputSize - (scope?.outputBytesUsed ?? 0);
  let available = remaining();
  let chunk = "";
  const flush = () => {
    if (!chunk) return;
    options.appendStdout(chunk);
    available = remaining();
    chunk = "";
  };
  const print = (path: string) => {
    const line = `${path}\n`;
    if (chunk.length + line.length > 32 * 1024) flush();
    if (scope && chunk.length + line.length <= available / 3) {
      chunk += line;
    } else {
      flush();
      options.appendStdout(line);
      available = remaining();
    }
  };

  const directories: { path: string; printOnLeave: boolean }[] = [];
  const leaveTo = (depth: number) => {
    while (directories.length > depth) {
      const directory = directories.pop();
      if (directory?.printOnLeave) print(directory.path);
    }
  };
  for (const [depth, basename, type] of entries) {
    if (depth > options.maxDepth) continue;
    leaveTo(depth);
    if (depth > 0) options.traversalBudget.discover(1);
    options.traversalBudget.visit(depth);
    const parent = directories[depth - 1];
    const path = parent
      ? `${parent.path === "/" ? "" : parent.path}/${basename}`
      : start;
    const name = depth
      ? basename
      : start.slice(start.lastIndexOf("/") + 1) || start;
    const matches =
      depth >= options.minDepth &&
      (!expr ||
        evaluateSimpleExpression(
          expr,
          name,
          path,
          type === "f",
          type === "d",
          type === "l",
        ).matches);
    if (type === "d") {
      directories.push({ path, printOnLeave: options.depthFirst && matches });
      if (options.depthFirst) continue;
    }
    if (matches) print(path);
  }
  leaveTo(0);
  flush();
  return true;
}
