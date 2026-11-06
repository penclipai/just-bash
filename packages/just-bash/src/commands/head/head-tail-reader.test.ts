import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import { bufferByteReader } from "../../utils/buffer-byte-reader.js";

class ReaderFs extends InMemoryFs {
  reads: Array<{ offset: number; length: number }> = [];
  closes = 0;
  async openByteReader(path: string) {
    const bytes = await super.readFileBuffer(path);
    const reader = bufferByteReader(bytes);
    const readAt = reader.readAt;
    return {
      size: reader.size,
      read: async (length = 65536, signal?: AbortSignal) => {
        this.reads.push({ offset: -1, length });
        return reader.read(length, signal);
      },
      readAt: async (offset: number, length: number, signal?: AbortSignal) => {
        this.reads.push({ offset, length });
        return readAt(offset, length, signal);
      },
      close: async () => {
        this.closes++;
        await reader.close();
      },
      cancel: reader.cancel,
    };
  }
}

describe("head and tail range readers", () => {
  it("reads only the requested head bytes", async () => {
    const fs = new ReaderFs({ "/input": "abc".repeat(100_000) });
    const result = await new Bash({ fs, cwd: "/" }).exec("head -c1 /input");
    expect(result).toMatchObject({ stdout: "a", stderr: "", exitCode: 0 });
    expect(fs.reads).toEqual([{ offset: -1, length: 1 }]);
    expect(fs.closes).toBe(1);
  });

  it("reads only the requested tail bytes", async () => {
    const fs = new ReaderFs({ "/input": "abc".repeat(100_000) });
    const result = await new Bash({ fs, cwd: "/" }).exec("tail -c2 /input");
    expect(result).toMatchObject({ stdout: "bc", stderr: "", exitCode: 0 });
    expect(fs.reads).toEqual([{ offset: 299_998, length: 2 }]);
    expect(fs.closes).toBe(1);
  });

  it("preserves last-line semantics across reverse windows", async () => {
    const fs = new ReaderFs({
      "/input": `before\n${"a".repeat(70_000)}\nend\n`,
    });
    const result = await new Bash({ fs, cwd: "/" }).exec("tail -n2 /input");
    expect(result).toMatchObject({
      stdout: `${"a".repeat(70_000)}\nend\n`,
      stderr: "",
      exitCode: 0,
    });
    expect(fs.reads.length).toBe(2);
  });

  it("retains full logical input admission for a range read", async () => {
    const fs = new ReaderFs({ "/input": "too large" });
    const result = await new Bash({
      fs,
      cwd: "/",
      executionLimits: { maxInputBytes: 2 },
    }).exec("head -c1 /input");
    expect(result.exitCode).toBe(126);
    expect(fs.reads).toEqual([]);
  });
});
