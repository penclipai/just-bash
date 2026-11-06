import type { RuntimeCommandContext } from "../../types.js";
import type { AwkProgram } from "./ast.js";
import type { AwkRuntimeContext } from "./interpreter/context.js";

/** Qualify the complete program before BEGIN or input/output effects. */
export function canStreamAwk(
  program: AwkProgram,
  runtime: AwkRuntimeContext,
  command: RuntimeCommandContext,
  files: readonly string[],
): boolean {
  // Raw stdin can choose whole-stream Latin1 after a late invalid byte. That
  // also changes fields and allocation limits, so its original decoder stays.
  if (
    !files.length ||
    files.includes("-") ||
    !command.fs.openByteReader ||
    (!command.writeOutput && !command.byteIO) ||
    runtime.RS !== "\n" ||
    program.functions.length
  )
    return false;
  const stack: unknown[] = [program];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
      continue;
    }
    const node = item as {
      type?: string;
      name?: string;
      array?: string;
      output?: unknown;
    };
    if (node.type === "getline" || node.type === "nextfile" || node.output)
      return false;
    if (["RS", "ARGV", "ARGC"].includes(node.name ?? node.array ?? ""))
      return false;
    if (
      node.type === "call" &&
      ["system", "close", "fflush"].includes(node.name ?? "")
    )
      return false;
    stack.push(...Object.values(node));
  }
  return true;
}
