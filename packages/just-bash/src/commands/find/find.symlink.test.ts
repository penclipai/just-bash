import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { ReadWriteFs } from "../../fs/read-write-fs/read-write-fs.js";

async function createEnv(): Promise<Bash> {
  const env = new Bash({
    files: {
      "/p/file.txt": "file",
      "/p/real-dir/child.txt": "child",
      "/target/hidden.txt": "hidden",
    },
  });
  await env.fs.symlink("missing", "/p/dangling-link");
  await env.fs.symlink("/target", "/p/directory-link");
  await env.fs.symlink("file.txt", "/p/file-link");
  return env;
}

describe("find symlinks", () => {
  it("matches symlinks in simple expressions", async () => {
    const env = await createEnv();

    expect(await env.exec("find /p -type l -name '*-link'")).toMatchObject({
      stdout: "/p/dangling-link\n/p/directory-link\n/p/file-link\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("matches symlinks with metadata and actions", async () => {
    const env = await createEnv();

    expect(await env.exec("find /p -type l -printf '%y %p\\n'")).toMatchObject({
      stdout: "l /p/dangling-link\nl /p/directory-link\nl /p/file-link\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("inspects symlink starting points without following", async () => {
    const env = await createEnv();

    expect(
      await env.exec("find /p/dangling-link /p/directory-link -type l"),
    ).toMatchObject({
      stdout: "/p/dangling-link\n/p/directory-link\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps default traversal and file types physical", async () => {
    const env = await createEnv();

    expect(await env.exec("find /p")).toMatchObject({
      stdout:
        "/p\n/p/dangling-link\n/p/directory-link\n/p/file-link\n/p/file.txt\n/p/real-dir\n/p/real-dir/child.txt\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await env.exec("find /p -type f")).toMatchObject({
      stdout: "/p/file.txt\n/p/real-dir/child.txt\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await env.exec("find /p -type d")).toMatchObject({
      stdout: "/p\n/p/real-dir\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("matches symlinks without typed directory entries", async () => {
    const source = await createEnv();
    const fs = new Proxy(source.fs, {
      get(target, property) {
        if (property === "readdirWithFileTypes") return undefined;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(await new Bash({ fs }).exec("find /p -type l")).toMatchObject({
      stdout: "/p/dangling-link\n/p/directory-link\n/p/file-link\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("inspects denied links without opening their targets", async () => {
    const temp = await mkdtemp(join(tmpdir(), "find-symlink-"));
    try {
      const root = join(temp, "root");
      const outside = join(temp, "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, "hidden.txt"), "outside");
      await symlink(outside, join(root, "escape"));
      const env = new Bash({ fs: new ReadWriteFs({ root }) });

      expect(await env.exec("find /escape -type l")).toMatchObject({
        stdout: "/escape\n",
        stderr: "",
        exitCode: 0,
      });
      expect(await env.exec("find /escape/hidden.txt")).toMatchObject({
        stdout: "",
        stderr: "find: /escape/hidden.txt: No such file or directory\n",
        exitCode: 1,
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
