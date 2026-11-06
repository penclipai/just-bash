import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";

describe("arithmetic substitution output", () => {
  it("captures backtick stdout before restoring the parent FD", async () => {
    const chunks: [string, string][] = [];
    const result = await new Bash().exec(
      "( echo $(( `printf 7` + 1 )) >/dev/null ) 2>/dev/null; echo END",
      {
        onOutput: (text, stream) => {
          chunks.push([text, stream]);
        },
      },
    );
    expect(result).toMatchObject({ stdout: "END\n", stderr: "", exitCode: 0 });
    expect(chunks).toEqual([["END\n", "stdout"]]);
  });
});
