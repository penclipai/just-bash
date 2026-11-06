import type { SedCommand } from "./types.js";

export interface SedLineSource {
  has(index: number): boolean;
  get(index: number): string;
  count(): number;
}

/** Retain one pair of offsets, rather than an array of every input line. */
export function createSedLineSource(content: string): SedLineSource {
  let current = -1,
    start = 0,
    end = 0;
  const has = (index: number): boolean => {
    if (index < current) {
      current = -1;
      start = 0;
      end = 0;
    }
    while (current < index) {
      const next = current < 0 ? 0 : end + 1;
      if (next >= content.length) return false;
      start = next;
      const newline = content.indexOf("\n", start);
      end = newline < 0 ? content.length : newline;
      current++;
    }
    return index >= 0 && start < content.length;
  };
  return {
    has,
    get(index) {
      return has(index) ? content.slice(start, end) : "";
    },
    count() {
      let lines = content.length && !content.endsWith("\n") ? 1 : 0;
      for (
        let at = content.indexOf("\n");
        at !== -1;
        at = content.indexOf("\n", at + 1)
      )
        lines++;
      return lines;
    },
  };
}

/** Only last-line addresses require a complete input newline count. */
export function needsLastLine(commands: readonly SedCommand[]): boolean {
  const pending = [commands];
  while (pending.length) {
    const group = pending.pop();
    if (!group) break;
    for (const command of group) {
      if (command.type === "label") continue;
      if (command.address?.start === "$" || command.address?.end === "$")
        return true;
      if (command.type === "group") pending.push(command.commands);
    }
  }
  return false;
}
