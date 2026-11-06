import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { createCommandContext } from "../../custom-commands.js";
import { ExecutionScope } from "../../execution-scope.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";
import { BrokenPipeError } from "../../interpreter/byte-pipe.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import { bufferByteReader } from "../../utils/buffer-byte-reader.js";
import { sedCommand } from "./sed.js";

class ChunkFs extends InMemoryFs {
  opened = 0;
  closed = 0;
  whole = 0;
  readError?: unknown;
  closeError?: unknown;
  onRead?: () => void;
  onClose?: () => void;
  override async readFile(path: string): Promise<string> {
    this.whole++;
    return super.readFile(path);
  }
  async openByteReader(path: string) {
    this.opened++;
    const reader = bufferByteReader(await super.readFileBuffer(path));
    return {
      ...reader,
      read: (size?: number, signal?: AbortSignal) => {
        this.onRead?.();
        if (this.readError) throw this.readError;
        return reader.read(Math.min(size ?? 3, 3), signal);
      },
      close: async () => {
        this.closed++;
        await reader.close();
        this.onClose?.();
        if (this.closeError) throw this.closeError;
      },
    };
  }
}

describe("streaming sed files", () => {
  it("reuses the engine for split text and line addresses", async () => {
    const files = {
      "/input": new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode("éa\nsecond\nlast"),
        0xff,
      ]),
    };
    const command = "sed -n -e '2,3p' -e 's/a/😀/gp' /input";
    const expected = await new Bash({ files }).exec(command);
    const fs = new ChunkFs(files);
    const actual = await new Bash({ fs }).exec(command);
    expect(actual).toMatchObject({
      stdout: expected.stdout,
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toBe(1);
    expect(fs.whole).toBe(0);
  });

  it("chooses the stateful fallback before reading", async () => {
    const fs = new ChunkFs({ "/input": "a\nb\nc\n" });
    const result = await new Bash({ fs }).exec("sed -n '1h;2g;p' /input");
    expect(result).toMatchObject({
      stdout: "a\na\nc\n",
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toBe(0);
    expect(fs.whole).toBe(1);
  });

  it("keeps the aggregate command output bound", async () => {
    const fs = new ChunkFs({ "/input": "1\n2\n3\n4\n5\n" });
    const result = await new Bash({
      fs,
      executionLimits: { maxStringLength: 8 },
    }).exec("sed 'p' /input");
    expect(result.exitCode).toBe(126);
    expect(result.executionFailure?.limitType).toBe("string_length");
  });

  it("batches small records before reading the next block", async () => {
    const events: string[] = [];
    class BatchFs extends InMemoryFs {
      async openByteReader(path: string) {
        const reader = bufferByteReader(await super.readFileBuffer(path));
        return {
          ...reader,
          read(size?: number, signal?: AbortSignal) {
            events.push("read");
            return reader.read(size, signal);
          },
        };
      }
    }
    const content = "row\n".repeat(500);
    const chunks: string[] = [];
    const result = await sedCommand.execute(
      ["s/row/next/", "/input"],
      createCommandContext({
        fs: new BatchFs({ "/input": content }),
        async writeOutput(text) {
          events.push("output");
          chunks.push(text);
        },
      }),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(chunks).toEqual(["next\n".repeat(500)]);
    expect(events).toEqual(["read", "output", "read"]);
  });

  it("keeps Unicode output blocks within writer bounds", async () => {
    const content = `${"汉😀".repeat(9000)}\n`;
    const chunks: string[] = [];
    const result = await sedCommand.execute(
      ["", "/input"],
      createCommandContext({
        fs: new ChunkFs({ "/input": content }),
        async writeOutput(text) {
          expect(text.length).toBeLessThanOrEqual(16_384);
          expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
            65_536,
          );
          chunks.push(text);
        },
      }),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(
      chunks
        .map((chunk) =>
          new TextDecoder().decode(new TextEncoder().encode(chunk)),
        )
        .join(""),
    ).toBe(content);
  });

  it("keeps reader cancellation and closes broken output", async () => {
    const fs = new ChunkFs({ "/input": "a\nb\n" });
    const controller = new AbortController();
    fs.onRead = () => controller.abort();
    fs.readError = new DOMException("read aborted", "AbortError");
    await expect(
      sedCommand.execute(
        ["p", "/input"],
        createCommandContext({
          fs,
          signal: controller.signal,
          async writeOutput() {},
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);
    fs.onRead = undefined;
    fs.readError = undefined;
    await expect(
      sedCommand.execute(
        ["p", "/input"],
        createCommandContext({
          fs,
          async writeOutput() {
            throw new BrokenPipeError();
          },
        }),
      ),
    ).rejects.toBeInstanceOf(BrokenPipeError);
    expect(fs.closed).toBe(2);
  });

  it("keeps primary read failure through a close failure", async () => {
    const fs = new ChunkFs({ "/input": "a\n" });
    const failure = new ExecutionLimitError("primary limit", "string_length");
    fs.readError = failure;
    fs.closeError = new Error("close failed");
    await expect(
      sedCommand.execute(
        ["p", "/input"],
        createCommandContext({ fs, async writeOutput() {} }),
      ),
    ).rejects.toBe(failure);
    expect(fs.closed).toBe(1);
  });

  it("validates close before publishing the final tail", async () => {
    const fs = new ChunkFs({ "/input": "last" });
    fs.closeError = Object.assign(new Error("bad proof"), { code: "EIO" });
    const chunks: string[] = [];
    const result = await sedCommand.execute(
      ["", "/input"],
      createCommandContext({
        fs,
        async writeOutput(text) {
          chunks.push(text);
        },
      }),
    );
    expect(result).toEqual({
      stdout: "",
      stderr: "sed: /input: Input/output error\n",
      exitCode: 1,
    });
    expect(chunks).toEqual([]);
    expect(fs.closed).toBe(1);
  });

  it("keeps a close-time stop as the primary failure", async () => {
    const fs = new ChunkFs({ "/input": "a\n" });
    const ctx = createCommandContext({ fs, async writeOutput() {} });
    const scope = new ExecutionScope(ctx.limits);
    ctx.executionScope = scope;
    const failure = new ExecutionLimitError("close stopped", "iterations");
    fs.onClose = () => scope.poisonAfterAbort(failure);
    fs.closeError = new Error("close failed");
    await expect(sedCommand.execute(["-n", "", "/input"], ctx)).rejects.toBe(
      failure,
    );
    expect(fs.closed).toBe(1);
  });

  it("observes cancellation after a successful close", async () => {
    const fs = new ChunkFs({ "/input": "a\n" });
    const controller = new AbortController();
    fs.onClose = () => controller.abort();
    await expect(
      sedCommand.execute(
        ["-n", "", "/input"],
        createCommandContext({
          fs,
          signal: controller.signal,
          async writeOutput() {},
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);
    expect(fs.closed).toBe(1);
  });
});
