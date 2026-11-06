import { assert, describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";

const passthrough = defineCommand(
  "pass",
  async (args, ctx) => {
    assert(ctx.execWithInheritedStdin);
    return ctx.execWithInheritedStdin(args[0], {
      cwd: ctx.cwd,
      args: args.slice(1),
      inheritOutput: true,
    });
  },
  { streamingStdin: true },
);

describe("custom nested output ownership", () => {
  it("forwards binary pipes and redirects within two bytes", async () => {
    for (const script of [
      "cat /payload | pass cat",
      "cat /payload | pass cat | cat >/out",
      "pass cat /payload >/out",
    ]) {
      const bash = new Bash({
        files: { "/payload": Uint8Array.of(0, 255) },
        customCommands: [passthrough],
        executionLimits: { maxOutputSize: 2 },
      });
      const seen: number[] = [];
      const result = await bash.exec(script, {
        onOutputBytes(text, stream, kind) {
          expect(stream).toBe("stdout");
          const bytes =
            kind === "bytes"
              ? Uint8Array.from(text, (character) => character.charCodeAt(0))
              : new TextEncoder().encode(text);
          seen.push(...bytes);
        },
      });
      expect(result).toMatchObject({ stderr: "", exitCode: 0 });
      expect(result.executionFailure).toBeUndefined();
      if (script.includes(">/out")) {
        expect(seen).toEqual([]);
        expect(await bash.fs.readFileBuffer("/out")).toEqual(
          Uint8Array.of(0, 255),
        );
      } else expect(seen).toEqual([0, 255]);
    }
  });

  it("keeps direct forwarding within one output byte", async () => {
    const result = await new Bash({
      customCommands: [passthrough],
      executionLimits: { maxOutputSize: 1 },
    }).exec("pass printf A");
    expect(result).toMatchObject({ stdout: "A", stderr: "", exitCode: 0 });
    expect(result.executionFailure).toBeUndefined();
  });

  it("keeps decoded results available to default transforms", async () => {
    const transform = defineCommand("transform", async (args, ctx) => {
      const execute =
        args[0] === "inherit" ? ctx.execWithInheritedStdin : ctx.exec;
      assert(execute);
      const result = await execute("printf é", { cwd: ctx.cwd });
      expect(result.stdout).toBe("é");
      return {
        stdout: `[${result.stdout}]`,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    });
    for (const mode of ["generic", "inherit"]) {
      const result = await new Bash({ customCommands: [transform] }).exec(
        `transform ${mode} | cat`,
      );
      expect(result).toMatchObject({ stdout: "[é]", stderr: "", exitCode: 0 });
    }
  });

  it("keeps default lifecycle headers before child output", async () => {
    const lifecycle = defineCommand("lifecycle", async (_args, ctx) => {
      assert(ctx.execWithInheritedStdin);
      let stdout = "";
      for (const name of ["pre", "main", "post"]) {
        stdout += `>${name}\n`;
        const result = await ctx.execWithInheritedStdin(`printf ${name}`, {
          cwd: ctx.cwd,
        });
        stdout += result.stdout;
      }
      return { stdout, stderr: "", exitCode: 0 };
    });
    const seen: string[] = [];
    const result = await new Bash({ customCommands: [lifecycle] }).exec(
      "lifecycle | cat",
      {
        onOutput: (text) => {
          seen.push(text);
        },
      },
    );
    expect(result).toMatchObject({
      stdout: ">pre\npre>main\nmain>post\npost",
      stderr: "",
      exitCode: 0,
    });
    expect(seen.join("")).toBe(result.stdout);
  });
});
