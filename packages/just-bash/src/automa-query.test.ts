import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import {
  createCommandContext,
  findCommand,
  parseCatArgs,
  parseFindExpressions,
  parseShell,
  parseWcArgs,
  printfCommand,
  resolveCommand,
} from "./automa-query.js";
import { findCommand as originalFind } from "./commands/find/find.js";
import { parseExpressions } from "./commands/find/parser.js";
import { printfCommand as originalPrintf } from "./commands/printf/printf.js";
import { InMemoryFs } from "./fs/in-memory-fs/in-memory-fs.js";
import { resolveCommand as originalResolve } from "./interpreter/command-resolution.js";
import { parse } from "./parser/parser.js";

it("query entry preserves original parsers and command results", async () => {
  expect(parseShell).toBe(parse);
  expect(parseFindExpressions).toBe(parseExpressions);
  expect(findCommand).toBe(originalFind);
  expect(printfCommand).toBe(originalPrintf);
  expect(resolveCommand).toBe(originalResolve);
  const result = await printfCommand.execute(
    ["%s:%s\n", "one", "two"],
    createCommandContext({
      fs: new InMemoryFs(),
      executionLimitProfile: "hardened",
    }),
  );
  expect(result.stdout).toBe("one:two\n");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

it("query operand parsers retain terminators and errors", () => {
  for (const [parseArgs, command] of [
    [parseCatArgs, "cat"],
    [parseWcArgs, "wc"],
  ] as const) {
    const parsed = parseArgs([command === "cat" ? "-n" : "-l", "--", "-input"]);
    expect(parsed).toMatchObject({
      ok: true,
      result: {
        flags: command === "cat" ? { number: true } : { lines: true },
        positional: ["-input"],
      },
    });
    const invalid = parseArgs(["--unknown"]);
    expect(invalid).toMatchObject({ ok: false });
    if (!invalid.ok) {
      expect(invalid.error).toEqual({
        stdout: "",
        stderr: `${command}: unrecognized option '--unknown'\n`,
        exitCode: 1,
      });
    }
  }
});

it("query browser bundle excludes the Shell and Node kernels", async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL("./automa-query.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(output.metafile.inputs);
  for (const forbidden of [
    "/src/Bash.ts",
    "/src/interpreter/interpreter.ts",
    "/src/interpreter/builtin-dispatch.ts",
    "/src/execution-scope.ts",
    "/src/commands/registry.ts",
    "/src/commands/python3/",
    "/src/commands/js-exec/",
    "/typescript/",
    "/sucrase/",
  ])
    expect(inputs.some((input) => `/${input}`.includes(forbidden))).toBe(false);
  expect(output.outputFiles).toHaveLength(1);
});
