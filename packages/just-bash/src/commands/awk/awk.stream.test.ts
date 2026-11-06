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
import { awkCommand2 } from "./awk2.js";

class ReaderFs extends InMemoryFs {
  opened: string[] = [];
  closed: string[] = [];
  reads = 0;
  whole = 0;
  failClose = false;
  failRead = false;
  onRead?: () => void;
  override async readFile(path: string): Promise<string> {
    this.whole++;
    return super.readFile(path);
  }
  async openByteReader(path: string) {
    this.opened.push(path);
    const reader = bufferByteReader(await super.readFileBuffer(path));
    return {
      ...reader,
      read: (size?: number, signal?: AbortSignal) => {
        this.reads++;
        this.onRead?.();
        if (this.failRead)
          throw new ExecutionLimitError("primary read limit", "string_length");
        return reader.read(Math.min(size ?? 3, 3), signal);
      },
      close: async () => {
        this.closed.push(path);
        await reader.close();
        if (this.failClose)
          throw Object.assign(new Error("close proof failed"), { code: "EIO" });
      },
    };
  }
}

describe("streaming awk", () => {
  it("reuses original records, fields and per-file counters", async () => {
    const files = {
      "/a": Uint8Array.from([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode("é:值\r\n\0:x\n"),
        0xff,
      ]),
      "/b": "last:field\n",
      "/empty": "",
    };
    const command =
      "awk -F: 'BEGIN {OFS=\"|\"} {print FILENAME,NR,FNR,NF,$2,RT} END {print NR,FNR}' /a /b /empty";
    const expected = await new Bash({ files, cwd: "/" }).exec(command);
    const fs = new ReaderFs(files);
    const result = await new Bash({ fs, cwd: "/" }).exec(command);
    expect(result).toMatchObject({
      stdout: expected.stdout,
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toEqual(["/a", "/b", "/empty"]);
    expect(fs.closed).toEqual(["/a", "/b", "/empty"]);
    expect(fs.whole).toBe(0);
  });
  it("keeps field separator updates in the original evaluator", async () => {
    const fs = new ReaderFs({ "/input": "one:two\nthree,four\n" });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      'awk \'BEGIN {FS=":"} {print $1; FS=","}\' /input',
    );
    expect(result).toMatchObject({
      stdout: "one\nthree\n",
      stderr: "",
      exitCode: 0,
    });
  });
  it("closes early exit input before executing END once", async () => {
    const fs = new ReaderFs({ "/input": "one\ntwo\nthree\n" });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      'awk \'BEGIN {print "begin"} {print NR; exit 7} END {print "end",NR}\' /input',
    );
    expect(result).toMatchObject({
      stdout: "begin\n1\nend 1\n",
      stderr: "",
      exitCode: 7,
    });
    expect(fs.reads).toBe(2);
    expect(fs.closed).toEqual(["/input"]);
  });
  it("admits the complete file before opening an early exit", async () => {
    const fs = new ReaderFs({ "/input": "one\n".repeat(30) });
    const result = await new Bash({
      fs,
      cwd: "/",
      executionLimits: { maxInputBytes: 100 },
    }).exec("awk '{exit}' /input || true");
    expect(result.exitCode).toBe(126);
    expect(fs.opened).toEqual([]);
  });
  it("validates source close before publishing END summaries", async () => {
    const fs = new ReaderFs({ "/input": "one\ntwo\n" });
    fs.failClose = true;
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "awk 'END {print NR}' /input",
    );
    expect(result).toMatchObject({
      stdout: "",
      stderr: "awk: close proof failed\n",
      exitCode: 2,
    });
    fs.failRead = true;
    const primary = await new Bash({ fs, cwd: "/" }).exec(
      "awk '{print}' /input || true",
    );
    expect(primary.exitCode).toBe(126);
    expect(primary.stderr).toContain("primary read limit");
  });
  it("selects advanced record separators before any stream IO", async () => {
    const fs = new ReaderFs({ "/input": "one:two:three" });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "awk 'BEGIN {RS=\":\"} {print NR,$0}' /input",
    );
    expect(result).toMatchObject({
      stdout: "1 one\n2 two\n3 three\n",
      stderr: "",
      exitCode: 0,
    });
    expect(fs.opened).toEqual([]);
    expect(fs.whole).toBe(1);
  });
  it("keeps raw stdin decoding and program stdin consumption", async () => {
    const fs = new ReaderFs({
      "/bytes": Uint8Array.from([0xc3, 0xa9, 0x68, 0x69, 0x74, 10, 0xff, 10]),
      "/input": "file row\n",
    });
    const result = await new Bash({ fs, cwd: "/" }).exec(
      "cat /bytes | awk '{print NR,$0}'; printf '{ print }\\n' | awk -f - /input; printf 'BEGIN {print 7}\\n' | awk -f -",
    );
    expect(result).toMatchObject({
      stdout: "1 Ã©hit\n2 ÿ\nfile row\n7\n",
      stderr: "",
      exitCode: 0,
    });
  });
  it("does not consume stdin after exit from BEGIN", async () => {
    const result = await awkCommand2.execute(
      ['BEGIN {print "early";exit} END {print NR}'],
      createCommandContext({
        fs: new InMemoryFs(),
        async readStdin() {
          throw new Error("unexpected read");
        },
      }),
    );
    expect(result).toEqual({ stdout: "early\n0\n", stderr: "", exitCode: 0 });
  });
  it("closes readers on cancellation and broken output pipes", async () => {
    const fs = new ReaderFs({ "/input": "one\ntwo\n" });
    const controller = new AbortController();
    fs.onRead = () => controller.abort();
    await expect(
      awkCommand2.execute(
        ["{print}", "/input"],
        createCommandContext({
          fs,
          signal: controller.signal,
          async writeOutput() {},
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionAbortedError);
    fs.onRead = undefined;
    await expect(
      awkCommand2.execute(
        ["{print}", "/input"],
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
  it("keeps a cumulative output budget after each drain", async () => {
    const fs = new ReaderFs({ "/input": "one\n".repeat(10) });
    const chunks: string[] = [];
    await expect(
      awkCommand2.execute(
        ["{print NR}", "/input"],
        createCommandContext({
          fs,
          executionLimits: { maxOutputSize: 8 },
          async writeOutput(text) {
            chunks.push(text);
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionLimitError);
    expect(chunks.join("")).toBe("1\n2\n3\n4\n");
    expect(fs.closed).toEqual(["/input"]);
  });

  it("preserves Unicode pairs across separate record writes", async () => {
    const fs = new ReaderFs({ "/input": "a\nb\n" });
    const chunks: string[] = [];
    const result = await awkCommand2.execute(
      ['BEGIN {ORS=""} {print sprintf("%c",NR==1?55296:56320)}', "/input"],
      createCommandContext({
        fs,
        executionLimits: { maxOutputSize: 5 },
        async writeOutput(text) {
          chunks.push(text);
        },
      }),
    );
    expect(chunks.join("") + result.stdout).toBe("\ud800\udc00");
    expect(result.exitCode).toBe(0);
  });

  it("keeps the decoded input expansion limit", async () => {
    const fs = new ReaderFs({ "/input": Uint8Array.of(0xff) });
    await expect(
      awkCommand2.execute(
        ["{print}", "/input"],
        createCommandContext({
          fs,
          executionLimits: { maxInputBytes: 2 },
          async writeOutput() {},
        }),
      ),
    ).rejects.toBeInstanceOf(ExecutionLimitError);
    expect(fs.closed).toEqual(["/input"]);
  });

  it("batches records and publishes before the next read", async () => {
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
    const fs = new BatchFs({ "/input": "row\n".repeat(500) });
    const chunks: string[] = [];
    const result = await awkCommand2.execute(
      ["{print NR}", "/input"],
      createCommandContext({
        fs,
        async writeOutput(text) {
          events.push("output");
          chunks.push(text);
        },
      }),
    );
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(chunks).toEqual([
      Array.from({ length: 500 }, (_, i) => `${i + 1}\n`).join(""),
    ]);
    expect(events).toEqual(["read", "output", "read"]);
  });
});
