import { expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("preserves parent $! across isolated foreground shells", async () => {
  const result = await new Bash().exec(
    'echo parent & parent=$!; wait "$parent"; captured=$(echo inner &); (echo other & wait); printf "%s:%s:%s\\n" "$parent" "$!" "$captured"',
  );
  expect(result.stdout).toBe("parent\nother\n2:2:inner\n");
  expect(result.stderr).toBe("");
});

it("does not publish a captured background tail twice", async () => {
  const chunks: string[] = [];
  const result = await new Bash().exec(
    'v=$(echo inner &); printf "[%s]\\n" "$v"',
    {
      onOutput: (text) => {
        chunks.push(text);
      },
    },
  );
  expect(result.stdout).toBe("[inner]\n");
  expect(result.output).toBe("[inner]\n");
  expect(chunks.join("")).toBe("[inner]\n");
});

it("does not lend capture credits to concurrent naked writes", async () => {
  const started = deferred(),
    release = deferred();
  const bash = new Bash({
    cwd: "/",
    defenseInDepth: false,
    executionLimits: { maxOutputSize: 4 },
    customCommands: [
      defineCommand("admitted", async (_args, ctx) => {
        await ctx.writeOutput?.("a", "stdout");
        started.resolve();
        await release.promise;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      defineCommand("naked", async (_args, ctx) => {
        await started.promise;
        try {
          await ctx.fs.writeFile("/dev/fd/63", "xxxx");
        } finally {
          release.resolve();
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    ],
  });
  const result = await bash.exec(": > >(naked & admitted; wait)");
  expect(result.exitCode).toBe(126);
  expect(result.executionFailure?.limitType).toBe("output_size");
});
