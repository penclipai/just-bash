import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { createCommandContext } from "../../custom-commands.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import { BrokenPipeError } from "../../interpreter/byte-pipe.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import { bufferByteReader } from "../../utils/buffer-byte-reader.js";
import { grepCommand } from "./grep.js";

class ChunkFs extends InMemoryFs {
  opened: string[] = [];
  closed: string[] = [];
  reads: number[] = [];
  whole = 0;
  failClose?: string;
  failRead = false;
  onRead?: () => void;
  override async readFileBuffer(path: string): Promise<Uint8Array> {
    this.whole++;
    return super.readFileBuffer(path);
  }
  async openByteReader(path: string) {
    this.opened.push(path);
    const at = this.reads.push(0) - 1;
    const reader = bufferByteReader(await super.readFileBuffer(path));
    return {
      size: reader.size,
      read: (size?: number, signal?: AbortSignal) => {
        this.reads[at]++;
        this.onRead?.();
        if (this.failRead)
          throw new ExecutionLimitError("primary read limit", "string_length");
        return reader.read(Math.min(size ?? 3, 3), signal);
      },
      close: async () => {
        this.closed.push(path);
        await reader.close();
        if (path === this.failClose)
          throw Object.assign(new Error("bad proof"), { code: "EIO" });
      },
      cancel: reader.cancel,
    };
  }
}

describe("streaming grep", () => {
  it("retains split UTF-8, BOM, NUL and CRLF matching", async () => {
    const input = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("é\0hit\r\nskip\nlast"),
      0xff,
    ]);
    const files = { "/input": input };
    const command = "grep -nEv '^skip$' /input";
    const expected = await new Bash({ files, cwd: "/" }).exec(command);
    const fs = new ChunkFs(files);
    const result = await new Bash({ fs, cwd: "/" }).exec(command);
    expect(result).toMatchObject({
      stdout: expected.stdout,
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toEqual(["/input"]);
    expect(fs.closed).toEqual(["/input"]);
    expect(fs.whole).toBe(0);
  });

  it("keeps summary counts, file names and selected-line status", async () => {
    const fs = new ChunkFs({ "/a": "hit\nhit\n", "/b": "none\n" });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "grep -cF hit /a /b; grep -lF hit /a /b; grep -LF hit /a /b",
    );
    expect(result).toMatchObject({
      stdout: "/a:2\n/b:0\n/a\n/b\n",
      stderr: "",
      exitCode: 0,
    });
    expect(fs.closed).toHaveLength(6);
  });

  it("limits matches and stops quiet readers before later files", async () => {
    const fs = new ChunkFs({ "/a": "hit\nhit\n", "/b": "hit\n" });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "grep -m1 -n hit /a; grep -qF hit /a /b",
    );
    expect(result).toMatchObject({
      stdout: "1:hit\n",
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toEqual(["/a", "/a"]);
    expect(fs.reads).toEqual([2, 2]);
  });

  it("admits complete logical input before opening quiet files", async () => {
    const fs = new ChunkFs({ "/large": "hit\n".repeat(30) });
    const result = await new Bash({
      fs,
      cwd: "/",
      executionLimits: { maxInputBytes: 100 },
    }).exec("grep -q hit /large || true");
    expect(result.exitCode).toBe(126);
    expect(fs.opened).toEqual([]);
  });

  it("validates close proofs before publishing summaries", async () => {
    const fs = new ChunkFs({ "/bad": "hit\n", "/good": "hit\n" });
    fs.failClose = "/bad";
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "grep -l hit /bad /good",
    );
    expect(result).toMatchObject({
      stdout: "/good\n",
      stderr: "grep: /bad: Input/output error\n",
      exitCode: 2,
    });
    fs.failRead = true;
    const failed = await new Bash({ fs, cwd: "/" }).exec(
      "grep hit /bad || true",
    );
    expect(failed.exitCode).toBe(126);
    expect(failed.stderr).toContain("primary read limit");
  });

  it("selects buffered context before opening streamed readers", async () => {
    const fs = new ChunkFs({ "/input": "hit\nnext\n" });
    const result = await new Bash({ fs, cwd: "/" }).exec("grep -A1 hit /input");
    expect(result).toMatchObject({
      stdout: "hit\nnext\n",
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toEqual([]);
    expect(fs.whole).toBe(1);
  });

  it("preserves the complete-file literal miss shortcut", async () => {
    const fs = new ChunkFs({ "/input": "none\n".repeat(10) });
    const result = await new Bash({
      fs,
      cwd: "/",
      executionLimits: { maxArrayElements: 4, maxLoopIterations: 4 },
    }).exec("grep -cF hit /input");
    expect(result).toMatchObject({ stdout: "0\n", stderr: "", exitCode: 1 });
  });

  it("keeps raw stdin decoding and safe ASCII summaries", async () => {
    const files = {
      "/bytes": Uint8Array.from([0xc3, 0xa9, 0x68, 0x69, 0x74, 10, 0xff, 10]),
    };
    const result = await new Bash({ files, cwd: "/" }).exec(
      "cat /bytes | grep -n .; cat /bytes | grep -Fc hit",
    );
    expect(result).toMatchObject({
      stdout: "1:Ã©hit\n2:ÿ\n1\n",
      stderr: "",
      exitCode: 0,
    });
    const output: Uint8Array[] = [];
    const reader = bufferByteReader(files["/bytes"]);
    const writer = {
      async write(bytes: Uint8Array) {
        output.push(bytes.slice());
      },
      async close() {},
      async abort() {},
    };
    const summary = await grepCommand.execute(
      ["-Fc", "hit"],
      createCommandContext({
        fs: new InMemoryFs(),
        byteIO: { stdin: reader, stdout: writer, stderr: writer },
        async readStdin() {
          throw new Error("unexpected whole stdin read");
        },
      }),
    );
    expect(summary).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(
      new TextDecoder().decode(
        Uint8Array.from(output.flatMap((chunk) => [...chunk])),
      ),
    ).toBe("1\n");
  });

  it("retains ordinary file errors and later valid output", async () => {
    const fs = new ChunkFs({ "/good": "hit\n" });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "grep hit /missing /good",
    );
    expect(result).toMatchObject({
      stdout: "/good:hit\n",
      stderr: "grep: /missing: No such file or directory\n",
      exitCode: 2,
    });
  });

  it("preserves output limit failures through shell recovery", async () => {
    const fs = new ChunkFs({ "/input": "hit hit\n" });
    const result = await new Bash({
      fs,
      cwd: "/",
      executionLimits: { maxOutputSize: 5 },
    }).exec("grep hit /input || true");
    expect(result.exitCode).toBe(126);
    expect(fs.closed).toEqual(["/input"]);
  });

  it("closes file readers on cancellation and broken pipes", async () => {
    const fs = new ChunkFs({ "/input": "hit\n" });
    const controller = new AbortController();
    fs.onRead = () => controller.abort();
    await expect(
      grepCommand.execute(
        ["hit", "/input"],
        createCommandContext({ fs, signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);
    fs.onRead = undefined;
    await expect(
      grepCommand.execute(
        ["hit", "/input"],
        createCommandContext({
          fs,
          async writeOutput() {
            throw new BrokenPipeError();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BrokenPipeError);
    expect(fs.closed).toEqual(["/input", "/input"]);
  });

  it("batches Unicode output within the byte writer block limit", async () => {
    const line = `hit${"汉😀".repeat(9000)}`;
    const fs = new ChunkFs({ "/input": `${line}\n` });
    const chunks: string[] = [];
    const result = await grepCommand.execute(
      ["hit", "/input"],
      createCommandContext({
        fs,
        async writeOutput(text) {
          expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
            65_536,
          );
          chunks.push(text);
        },
      }),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(chunks.join("")).toBe(`${line}\n`);
  });

  it("publishes selected lines before the next source block", async () => {
    const events: string[] = [];
    class ProgressFs extends InMemoryFs {
      async openByteReader(path: string) {
        const reader = bufferByteReader(await super.readFileBuffer(path));
        return {
          ...reader,
          read(size?: number, signal?: AbortSignal) {
            events.push("read");
            return reader.read(Math.min(size ?? 4, 4), signal);
          },
          async close() {
            events.push("close");
            await reader.close();
          },
        };
      }
    }
    const fs = new ProgressFs({ "/input": "hit\nlater\n" });
    const chunks: string[] = [];
    const result = await grepCommand.execute(
      ["hit", "/input"],
      createCommandContext({
        fs,
        async writeOutput(text) {
          events.push("output");
          chunks.push(text);
        },
      }),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(chunks.join("")).toBe("hit\n");
    expect(events.slice(0, 3)).toEqual(["read", "output", "read"]);
    expect(events.at(-1)).toBe("close");
  });
});
