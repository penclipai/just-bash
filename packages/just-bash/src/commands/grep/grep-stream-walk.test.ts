import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  opendir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { SnapshotTreeEntry } from "../../fs/interface.js";

it("matches GNU directory order for cached and live grep", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grep-stream-"));
  try {
    const files: Record<string, string> = {
      "/w/.git/config": "needle hidden\n",
      "/w/.dot.txt": "needle dot\n",
      "/w/a": "needle plain\nneedle two\n",
      "/w/nested/one.txt": "needle nested\n",
      "/w/line\nbreak": "needle newline\n",
    };
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "nested"));
    for (const [path, text] of Object.entries(files))
      await writeFile(join(dir, path.slice(3)), text);
    await symlink("nested", join(dir, "link"));
    const rows: SnapshotTreeEntry[] = [[0, "w", "d"]];
    const orders = new Map<string, string[]>();
    async function collect(path: string, depth: number) {
      const names: string[] = [];
      orders.set(`/w${path}`, names);
      for await (const entry of await opendir(dir + path)) {
        names.push(entry.name);
        const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "l";
        rows.push([depth, entry.name, type]);
        if (type === "d") await collect(`${path}/${entry.name}`, depth + 1);
      }
    }
    await collect("", 1);
    for (const cached of [false, true]) {
      const listing = JSON.stringify(rows);
      const fs = Object.assign(new InMemoryFs(files), {
        readSnapshotTree: vi.fn(async () => (cached ? listing : undefined)),
      });
      await fs.symlink("nested", "/w/link");
      const list = fs.readdirWithFileTypes.bind(fs);
      const lists = vi
        .spyOn(fs, "readdirWithFileTypes")
        .mockImplementation(async (path) => {
          const names = orders.get(path) ?? [];
          return (await list(path)).sort(
            (a, b) => names.indexOf(a.name) - names.indexOf(b.name),
          );
        });
      const bash = new Bash({ fs, cwd: "/w" });
      for (const args of [
        ["-rn", "needle", "."],
        ["-rn", "--exclude-dir=.git", "--include=*.txt", "needle", "."],
      ]) {
        const want = execFileSync("grep", args, { cwd: dir, encoding: "utf8" });
        const result = await bash.exec(
          `grep ${args.map((arg) => `'${arg}'`).join(" ")}`,
        );
        expect(result).toMatchObject({ stdout: want, stderr: "", exitCode: 0 });
      }
      expect(fs.readSnapshotTree).toHaveBeenCalledWith("/w", 255, true);
      expect(lists.mock.calls.length > 0).toBe(!cached);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("stops before listing the next directory after head", async () => {
  const fs = new InMemoryFs({
    "/w/a": "hit\n".repeat(4),
    "/w/z/later": "hit\n",
  });
  const list = vi.spyOn(fs, "readdirWithFileTypes");
  const read = vi.spyOn(fs, "readFileBuffer");
  const result = await new Bash({ fs, cwd: "/w" }).exec(
    "grep -rn hit . | head -2",
  );
  expect(result).toMatchObject({
    stdout: "./a:1:hit\n./a:2:hit\n",
    stderr: "",
    exitCode: 0,
  });
  expect(list.mock.calls).toEqual([["/w"]]);
  expect(read.mock.calls).toEqual([["/w/a"]]);
});

it("warns on a dereferenced ancestor and follows file links", async () => {
  const fs = new InMemoryFs({ "/w/a": "hit\n" });
  await fs.symlink(".", "/w/loop");
  await fs.symlink("a", "/w/alias");
  const bash = new Bash({ fs, cwd: "/w" });
  expect(await bash.exec("grep -R hit .")).toMatchObject({
    stdout: "./a:hit\n./alias:hit\n",
    stderr: "grep: ./loop: warning: recursive directory loop\n",
    exitCode: 0,
  });
});

it("checks large ASCII misses without changing decoding", async () => {
  const padding = "x".repeat(16384);
  const fs = new InMemoryFs({
    "/w/miss": `${padding}TOD\n`,
    "/w/hit": `${padding}\nTODO ✓\n`,
  });
  const bash = new Bash({ fs, cwd: "/w" });
  expect(await bash.exec("grep -rc TODO .")).toMatchObject({
    stdout: "./hit:1\n./miss:0\n",
    exitCode: 0,
  });
  expect(await bash.exec("grep -ri 'todo ✓' .")).toMatchObject({
    stdout: "./hit:TODO ✓\n",
    exitCode: 0,
  });
});

it("charges cached negative bytes without transferring bodies", async () => {
  const bytes = new Uint8Array(16384);
  const fs = Object.assign(new InMemoryFs({ "/w/a": bytes }), {
    cachedFileMissingPrefix: vi.fn(async () => true),
  });
  const read = vi.spyOn(fs, "readFileBuffer");
  const bash = new Bash({
    fs,
    cwd: "/w",
    executionLimits: { maxInputBytes: 16383 },
  });
  const result = await bash.exec("grep -rn TODO .");
  expect(result.exitCode).toBe(126);
  expect(result.stderr).toContain("aggregate input size limit");
  expect(fs.cachedFileMissingPrefix).toHaveBeenCalledWith(
    "/w/a",
    "TODO",
    16384,
  );
  expect(read).not.toHaveBeenCalled();
});
