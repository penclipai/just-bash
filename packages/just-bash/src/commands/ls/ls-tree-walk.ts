import type { SnapshotTreeEntry } from "../../fs/interface.js";
import type { FileTraversalBudget } from "../../fs/traversal.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";

interface SnapshotNode {
  name: string;
  type: SnapshotTreeEntry[2];
  children: SnapshotNode[];
}

export interface LsSnapshotOptions {
  showAll: boolean;
  showAlmostAll: boolean;
  reverse: boolean;
  traversalBudget: FileTraversalBudget;
}

/**
 * Name-order `ls -R` for a complete physical snapshot. Long listings, classify,
 * and size/time sorts still use the existing walk because they need stats.
 * Returns undefined when the filesystem has no snapshot for this root.
 */
export async function listSnapshotTree(
  ctx: RuntimeCommandContext,
  path: string,
  options: LsSnapshotOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
  const root = ctx.fs.resolvePath(ctx.cwd, path);
  const listing = await ctx.fs.readSnapshotTree?.(
    root,
    ctx.limits.maxTraversalDepth,
  );
  if (listing === undefined) return undefined;
  const entries: SnapshotTreeEntry[] = JSON.parse(listing);
  if (entries.length === 0 || entries[0][0] !== 0 || entries[0][2] !== "d")
    return undefined;

  const tree = toTree(entries);
  const showHidden = options.showAll || options.showAlmostAll;
  let stdout = "";
  const sections: string[] = [];

  const visit = (node: SnapshotNode, display: string, depth: number) => {
    if (depth > 0) options.traversalBudget.visit(depth);
    else options.traversalBudget.checkpoint();
    let names = node.children
      .map((child) => child.name)
      .filter((name) => showHidden || !name.startsWith("."));
    if (options.showAll) names = [".", "..", ...names];
    if (names.length > ctx.limits.maxArrayElements) {
      throw new ExecutionLimitError(
        `ls: array element limit exceeded (${ctx.limits.maxArrayElements})`,
        "array_elements",
      );
    }
    options.traversalBudget.reserve(names.length);
    names.sort();
    if (options.reverse) names.reverse();

    let section = `${display}:\n`;
    if (names.length) section += `${names.join("\n")}\n`;
    sections.push(section);

    const byName = new Map(node.children.map((child) => [child.name, child]));
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const child = byName.get(name);
      if (child?.type !== "d") continue;
      const childDisplay = display === "." ? `./${name}` : `${display}/${name}`;
      visit(child, childDisplay, depth + 1);
    }
  };

  visit(tree, path, 0);
  stdout = sections.join("\n");
  return { stdout, stderr: "", exitCode: 0 };
}

function toTree(entries: SnapshotTreeEntry[]): SnapshotNode {
  const root: SnapshotNode = {
    name: entries[0][1],
    type: entries[0][2],
    children: [],
  };
  const stack = [root];
  for (let i = 1; i < entries.length; i++) {
    const [depth, name, type] = entries[i];
    while (stack.length > depth) stack.pop();
    const parent = stack[stack.length - 1];
    const node: SnapshotNode = { name, type, children: [] };
    parent.children.push(node);
    if (type === "d") stack.push(node);
  }
  return root;
}
