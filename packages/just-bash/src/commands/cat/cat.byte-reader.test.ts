import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";

describe("cat byte reader failure precedence", () => {
  it("keeps resource failure when reader close also fails", async () => {
    let closes = 0;
    class FailureFs extends InMemoryFs {
      async openByteReader() {
        return {
          size: 1,
          async read(): Promise<Uint8Array | null> {
            throw new ExecutionLimitError("read limit", "output_size");
          },
          async close() {
            closes++;
            throw Object.assign(new Error("close failed"), { code: "EIO" });
          },
          async cancel() {},
        };
      }
    }
    const result = await new Bash({ fs: new FailureFs(), cwd: "/" }).exec(
      "cat /input; printf forbidden",
    );
    expect(result).toMatchObject({
      stdout: "",
      stderr: "bash: read limit\n",
      exitCode: 126,
      executionFailure: { kind: "resource-limit", limitType: "output_size" },
    });
    expect(closes).toBe(1);
  });
});
