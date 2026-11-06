import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import { bufferByteReader } from "../../utils/buffer-byte-reader.js";

describe("wc filesystem byte readers", () => {
  it("retains other files when a close proof fails", async () => {
    const closed: string[] = [];
    class CloseFs extends InMemoryFs {
      async openByteReader(path: string) {
        const reader = bufferByteReader(await super.readFileBuffer(path));
        return {
          ...reader,
          async close() {
            closed.push(path);
            await reader.close();
            if (path === "/bad")
              throw Object.assign(new Error("close proof failed"), {
                code: "EIO",
              });
          },
        };
      }
    }
    const result = await new Bash({
      fs: new CloseFs({ "/first": "a\n", "/bad": "b\n", "/last": "c\n" }),
      cwd: "/",
    }).exec("wc -l /first /bad /last");
    expect(result).toMatchObject({
      stdout: "1 /first\n1 /last\n2 total\n",
      stderr: "wc: /bad: Input/output error\n",
      exitCode: 1,
    });
    expect(closed).toEqual(["/first", "/bad", "/last"]);
  });

  it("uses bounded raw reads and closes every input", async () => {
    let opened = 0,
      closed = 0;
    const reads: number[] = [];
    class ByteFs extends InMemoryFs {
      override async readFileBuffer(): Promise<Uint8Array> {
        throw new Error("unexpected whole-file command read");
      }
      async openByteReader(path: string) {
        opened++;
        const number = reads.push(0) - 1;
        const reader = bufferByteReader(await super.readFileBuffer(path));
        return {
          size: reader.size,
          read: (size?: number, signal?: AbortSignal) => {
            reads[number]++;
            return reader.read(Math.min(size ?? 2, 2), signal);
          },
          close: async () => {
            closed++;
            await reader.close();
          },
          cancel: reader.cancel,
        };
      }
    }
    const bash = new Bash({ fs: new ByteFs({ "/input": "é\nx" }), cwd: "/" });
    const result = await bash.exec("wc -l /input; wc -c /input; wc -m /input");
    expect(result).toMatchObject({
      stdout: "1 /input\n4 /input\n3 /input\n",
      stderr: "",
      exitCode: 0,
    });
    expect({ opened, closed }).toEqual({ opened: 3, closed: 3 });
    expect(reads[1]).toBe(0);
  });
});
