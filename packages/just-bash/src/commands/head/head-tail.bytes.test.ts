import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { bytesFromUint8Array } from "../../encoding.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { IFileSystem } from "../../fs/interface.js";

function byteArrayFs(files: Record<string, Uint8Array>): IFileSystem {
  const inner = new InMemoryFs(files);
  return new Proxy(inner, {
    get(target, key) {
      if (key === "readFileBytes") return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("byte-array file slices match GNU head and tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "head-tail-bytes-"));
  const input = new Uint8Array([
    0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad, 10, 0xff, 0, 0x80, 10, 0x61,
  ]);
  try {
    await writeFile(join(directory, "input"), input);
    const bash = new Bash({
      fs: byteArrayFs({ "/input": input }),
      defenseInDepth: false,
    });
    for (const [command, args] of [
      ["head", ["-n", "1"]],
      ["tail", ["-n", "2"]],
      ["tail", ["-n", "+2"]],
      ["head", ["-c", "5"]],
      ["tail", ["-c", "4"]],
    ] as const) {
      const native = spawnSync(command, [...args, "input"], { cwd: directory });
      expect(native.status).toBe(0);
      expect(native.stderr.toString()).toBe("");
      const result = await bash.exec(
        `${command} ${args.join(" ")} /input > /out`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(await bash.fs.readFileBuffer("/out")).toEqual(
        new Uint8Array(native.stdout),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains an optional byte-string filesystem read", async () => {
  const input = new TextEncoder().encode("first\nlast");
  let reads = 0;
  class BytesFs extends InMemoryFs {
    override async readFileBytes(path: string) {
      if (path === "/input") {
        reads++;
        return bytesFromUint8Array(input);
      }
      return super.readFileBytes(path);
    }
    override async readFileBuffer(path: string) {
      if (path === "/input") throw new Error("unexpected byte-array read");
      return super.readFileBuffer(path);
    }
  }
  const bash = new Bash({ fs: new BytesFs({ "/input": input }) });
  const result = await bash.exec("head -n 1 /input; tail -n 1 /input");
  expect(result.stdout).toBe("first\nlast");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(reads).toBe(2);
});

it("charges whole byte-array inputs before selecting output", async () => {
  const bash = new Bash({
    fs: byteArrayFs({ "/input": new TextEncoder().encode("abcdef") }),
    defenseInDepth: false,
    executionLimitProfile: "hardened",
    executionLimits: { maxInputBytes: 8 },
  });
  const result = await bash.exec("head -c 1 /input; tail -c 1 /input");
  expect(result.exitCode).toBe(126);
  expect(result.executionFailure?.kind).toBe("resource-limit");
});
