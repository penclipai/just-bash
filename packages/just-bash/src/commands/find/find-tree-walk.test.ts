import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/in-memory-fs.js";
import type { SnapshotTreeEntry } from "../../fs/interface.js";

async function snapshot(path: string, entries: SnapshotTreeEntry[], depth = 0) {
  const stat = await lstat(path);
  const type = stat.isDirectory() ? "d" : stat.isFile() ? "f" : "l";
  entries.push([depth, basename(path), type]);
  if (stat.isDirectory()) {
    // opendir preserves the directory stream order GNU find observes.
    for await (const entry of await opendir(path))
      await snapshot(join(path, entry.name), entries, depth + 1);
  }
}

it("matches native find order and name/type/depth predicates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "find-snapshot-"));
  try {
    await mkdir(join(cwd, "src/empty"), { recursive: true });
    await writeFile(join(cwd, "src/file.ts"), "");
    await writeFile(join(cwd, "src/line\nbreak.ts"), "");
    await symlink("src", join(cwd, "link"));
    const rows: SnapshotTreeEntry[] = [];
    await snapshot(cwd, rows);
    const listing = JSON.stringify(rows);
    const readSnapshotTree = vi.fn(async (path: string) =>
      path === "/project" ? listing : undefined,
    );
    const fs = Object.assign(new InMemoryFs(), { readSnapshotTree });
    const bash = new Bash({ cwd: "/project", fs });
    const list = vi.spyOn(fs, "readdirWithFileTypes");
    const cases = [
      { shell: "find .", args: ["."] },
      { shell: "find . -depth", args: [".", "-depth"] },
      {
        shell: "find . -type f -name '*.ts'",
        args: [".", "-type", "f", "-name", "*.ts"],
      },
      {
        shell: "find . -mindepth 1 -maxdepth 1",
        args: [".", "-mindepth", "1", "-maxdepth", "1"],
      },
    ];
    for (const { shell, args } of cases) {
      const stdout = execFileSync("find", args, { cwd, encoding: "utf8" });
      expect(await bash.exec(shell)).toMatchObject({
        stdout,
        stderr: "",
        exitCode: 0,
      });
    }
    expect(readSnapshotTree).toHaveBeenCalledTimes(4);
    expect(list).not.toHaveBeenCalled();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it("preserves unreadable-directory and multiple-root output", async () => {
  const readSnapshotTree = vi.fn(async () => undefined);
  const fs = Object.assign(
    new InMemoryFs({ "/ready": "", "/locked/secret": "" }),
    { readSnapshotTree },
  );
  const list = fs.readdirWithFileTypes.bind(fs);
  vi.spyOn(fs, "readdirWithFileTypes").mockImplementation(async (path) => {
    if (path === "/locked") throw new Error("EACCES: permission denied");
    return list(path);
  });
  const bash = new Bash({ fs });
  expect(await bash.exec("find /ready /locked")).toMatchObject({
    stdout: "/ready\n/locked\n",
    stderr: "find: /locked: Permission denied\n",
    exitCode: 1,
  });
  expect(readSnapshotTree).not.toHaveBeenCalled();
  expect(await bash.exec("find /locked")).toMatchObject({
    stdout: "/locked\n",
    stderr: "find: /locked: Permission denied\n",
    exitCode: 1,
  });
  expect(readSnapshotTree).toHaveBeenCalledOnce();
});

it("keeps exec on the live filesystem", async () => {
  const readSnapshotTree = vi.fn();
  const fs = Object.assign(new InMemoryFs({ "/p/only": "contents" }), {
    readSnapshotTree,
  });
  expect(
    await new Bash({ fs }).exec("find /p -type f -exec cat {} +"),
  ).toMatchObject({
    stdout: "contents",
    stderr: "",
    exitCode: 0,
  });
  expect(readSnapshotTree).not.toHaveBeenCalled();
});

it("charges traversal and preserves whole lines on overflow", async () => {
  const tree = JSON.stringify([
    [0, "p", "d"],
    [1, "你", "f"],
  ]);
  const fs = Object.assign(new InMemoryFs(), {
    readSnapshotTree: async () => tree,
  });
  const limited = new Bash({ fs, executionLimits: { maxTraversalEntries: 1 } });
  expect((await limited.exec("find /p")).exitCode).not.toBe(0);
  const capped = new Bash({ fs, executionLimits: { maxOutputSize: 5 } });
  const failed = await capped.exec("find /p");
  expect(failed.exitCode).not.toBe(0);
  expect(failed.stdout).toBe("/p\n");
});
