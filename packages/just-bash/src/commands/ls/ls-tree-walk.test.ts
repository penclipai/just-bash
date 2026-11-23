import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readlink,
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
  const type = stat.isDirectory()
    ? "d"
    : stat.isSymbolicLink()
      ? "l"
      : stat.isFile()
        ? "f"
        : "?";
  entries.push([depth, basename(path), type]);
  if (stat.isDirectory()) {
    for await (const entry of await opendir(path))
      await snapshot(join(path, entry.name), entries, depth + 1);
  }
}

async function withTree(
  setup: (cwd: string) => Promise<void>,
  run: (args: {
    cwd: string;
    bash: Bash;
    readSnapshotTree: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "ls-snapshot-"));
  try {
    await setup(cwd);
    const rows: SnapshotTreeEntry[] = [];
    await snapshot(cwd, rows);
    const listing = JSON.stringify(rows);
    const readSnapshotTree = vi.fn(async (path: string) => {
      if (path === "/project") return listing;
      if (!path.startsWith("/project/")) return undefined;
      const parts = path.slice("/project/".length).split("/").filter(Boolean);
      let index = 0;
      for (const part of parts) {
        const startDepth = rows[index][0];
        let found = -1;
        for (let i = index + 1; i < rows.length; i++) {
          if (rows[i][0] <= startDepth) break;
          if (rows[i][0] === startDepth + 1 && rows[i][1] === part) {
            found = i;
            break;
          }
        }
        if (found < 0) return undefined;
        index = found;
      }
      const start = index;
      const startDepth = rows[start][0];
      const slice: SnapshotTreeEntry[] = [];
      for (let i = start; i < rows.length; i++) {
        const [entryDepth, name, type] = rows[i];
        if (i > start && entryDepth <= startDepth) break;
        slice.push([entryDepth - startDepth, name, type]);
      }
      return JSON.stringify(slice);
    });
    const fs = Object.assign(new InMemoryFs(), { readSnapshotTree });
    await fs.mkdir("/project", { recursive: true });
    const materialize = async (realPath: string, virtualPath: string) => {
      const stat = await lstat(realPath);
      if (stat.isSymbolicLink()) {
        await fs.symlink(await readlink(realPath), virtualPath);
        return;
      }
      if (stat.isDirectory()) {
        if (virtualPath !== "/project") await fs.mkdir(virtualPath);
        for await (const entry of await opendir(realPath))
          await materialize(
            join(realPath, entry.name),
            `${virtualPath}/${entry.name}`,
          );
        return;
      }
      if (stat.isFile())
        await fs.writeFile(virtualPath, await readFile(realPath));
    };
    await materialize(cwd, "/project");
    const bash = new Bash({ cwd: "/project", fs });
    const list = vi.spyOn(fs, "readdirWithFileTypes");
    await run({ cwd, bash, readSnapshotTree, list });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function nativeLs(args: string[], cwd: string): string {
  return execFileSync("/usr/bin/ls", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
}

it("matches GNU ls -R and does not readdir when a snapshot is available", async () => {
  await withTree(
    async (cwd) => {
      await mkdir(join(cwd, "dir/sub"), { recursive: true });
      await mkdir(join(cwd, "empty"));
      await mkdir(join(cwd, "dir/.hid"));
      await writeFile(join(cwd, "file.txt"), "a\n");
      await writeFile(join(cwd, "dir/file1.txt"), "b\n");
      await writeFile(join(cwd, "dir/sub/file2.txt"), "c\n");
      await writeFile(join(cwd, ".hidden"), "h\n");
      await symlink("file.txt", join(cwd, "link"));
      await symlink("dir", join(cwd, "dirlink"));
    },
    async ({ cwd, bash, readSnapshotTree, list }) => {
      const cases = [
        ["-R"],
        ["-R", "."],
        ["-aR"],
        ["-AR"],
        ["-rR"],
        ["-R", "dir"],
        ["-R", "dir", "empty"],
      ];
      for (const args of cases) {
        const stdout = nativeLs(args, cwd);
        const shell = ["ls", ...args].join(" ");
        expect(await bash.exec(shell), shell).toMatchObject({
          stdout,
          stderr: "",
          exitCode: 0,
        });
      }
      expect(readSnapshotTree).toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    },
  );
});

it("falls back to readdir when long, classify, or time/size sort is requested", async () => {
  const readSnapshotTree = vi.fn(async () =>
    JSON.stringify([
      [0, "project", "d"],
      [1, "file.txt", "f"],
    ] satisfies SnapshotTreeEntry[]),
  );
  const fs = Object.assign(new InMemoryFs({ "/project/file.txt": "x" }), {
    readSnapshotTree,
  });
  const bash = new Bash({ cwd: "/project", fs });
  const list = vi.spyOn(fs, "readdirWithFileTypes");
  for (const shell of ["ls -lR", "ls -FR", "ls -tR", "ls -SR"]) {
    const result = await bash.exec(shell);
    expect(result.exitCode, shell).toBe(0);
  }
  expect(readSnapshotTree).not.toHaveBeenCalled();
  expect(list).toHaveBeenCalled();
});

it("falls back when the filesystem has no snapshot", async () => {
  const fs = new InMemoryFs({
    "/dir/root.txt": "root",
    "/dir/subdir/file.txt": "file",
  });
  const bash = new Bash({ cwd: "/", fs });
  const list = vi.spyOn(fs, "readdirWithFileTypes");
  expect(await bash.exec("ls -R /dir")).toMatchObject({
    stdout: "/dir:\nroot.txt\nsubdir\n\n/dir/subdir:\nfile.txt\n",
    stderr: "",
    exitCode: 0,
  });
  expect(list).toHaveBeenCalled();
});
