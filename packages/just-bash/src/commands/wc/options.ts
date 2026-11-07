import { type ParseResult, parseArgs } from "../../utils/args.js";

type WcArgumentDefinitions = Record<
  "lines" | "words" | "bytes" | "chars",
  { short?: string; long?: string; type: "boolean" }
>;

const argDefs: WcArgumentDefinitions = {
  lines: { short: "l", long: "lines", type: "boolean" as const },
  words: { short: "w", long: "words", type: "boolean" as const },
  bytes: { short: "c", long: "bytes", type: "boolean" as const },
  chars: { short: "m", long: "chars", type: "boolean" as const },
};

export function parseWcArgs(
  args: string[],
): ParseResult<WcArgumentDefinitions> {
  return parseArgs("wc", args, argDefs);
}
