import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { defineCommand } from "../../custom-commands.js";
import { latin1FromBytes } from "../../encoding.js";
import { readStdin } from "../../utils/read-stdin.js";

function shell() {
  return new Bash({
    files: { "/empty": "", "/lines": "first\nsecond\n" },
    customCommands: [
      defineCommand("input-kind", async (_args, ctx) => ({
        stdout: `${ctx.stdinProvided ? "provided" : "absent"}:${latin1FromBytes(await readStdin(ctx)).length}\n`,
        stderr: "",
        exitCode: 0,
      })),
    ],
  });
}

describe("nested shell stdin ownership", () => {
  it("keeps absent stdin absent through nested shells", async () => {
    const result = await shell().exec(`bash -c "sh -c 'input-kind'"`);
    expect(result).toMatchObject({
      stdout: "absent:0\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps an empty file redirection explicit", async () => {
    const result = await shell().exec("bash -c 'input-kind' < /empty");
    expect(result).toMatchObject({
      stdout: "provided:0\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps an empty pipe explicit", async () => {
    const result = await shell().exec("printf '' | sh -c 'input-kind'");
    expect(result).toMatchObject({
      stdout: "provided:0\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("shares descriptor consumption with the caller", async () => {
    const result = await shell().exec(
      `exec 3< /lines; bash -c 'read a; printf "%s\\n" "$a"' <&3; read -u 3 b; printf "%s\\n" "$b"`,
    );
    expect(result).toMatchObject({
      stdout: "first\nsecond\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps background shells away from parent stdin", async () => {
    const bash = shell();
    const result = await bash.exec(
      `{ bash -c 'cat > /background' & wait; read a; printf "%s\\n" "$a"; } < /lines`,
    );
    expect(result).toMatchObject({
      stdout: "first\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await bash.fs.readFile("/background")).toBe("");
  });

  it("returns remaining group input to the caller", async () => {
    const result = await shell().exec(
      `{ bash -c 'read a; printf "%s\\n" "$a"'; read b; printf "%s\\n" "$b"; } < /lines`,
    );
    expect(result).toMatchObject({
      stdout: "first\nsecond\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
