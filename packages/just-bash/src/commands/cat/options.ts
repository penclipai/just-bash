import { type ParseResult, parseArgs } from "../../utils/args.js";

type CatArgumentDefinitions = Record<
  | "number"
  | "numberNonblank"
  | "showEnds"
  | "showTabs"
  | "showNonprinting"
  | "showAll"
  | "squeeze"
  | "vE"
  | "vT"
  | "ignored",
  { short?: string; long?: string; type: "boolean" }
>;

const argDefs: CatArgumentDefinitions = {
  number: { short: "n", long: "number", type: "boolean" as const },
  numberNonblank: {
    short: "b",
    long: "number-nonblank",
    type: "boolean" as const,
  },
  showEnds: { short: "E", long: "show-ends", type: "boolean" as const },
  showTabs: { short: "T", long: "show-tabs", type: "boolean" as const },
  showNonprinting: {
    short: "v",
    long: "show-nonprinting",
    type: "boolean" as const,
  },
  showAll: { short: "A", long: "show-all", type: "boolean" as const },
  squeeze: { short: "s", long: "squeeze-blank", type: "boolean" as const },
  vE: { short: "e", type: "boolean" as const },
  vT: { short: "t", type: "boolean" as const },
  ignored: { short: "u", type: "boolean" as const },
};

export function parseCatArgs(
  args: string[],
): ParseResult<CatArgumentDefinitions> {
  return parseArgs("cat", args, argDefs);
}
