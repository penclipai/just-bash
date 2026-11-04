import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { InMemoryFs } from "../../fs/in-memory-fs/index.js";

/** Wraps an fs to count reads and fail chosen paths with a given code. */
function instrumented(
  files: Record<string, string>,
  fail: Record<string, string> = {},
) {
  const fs = new InMemoryFs(files);
  const reads: string[] = [];
  const readFileBuffer = fs.readFileBuffer.bind(fs);
  fs.readFileBuffer = async (path: string) => {
    reads.push(path);
    if (fail[path])
      throw Object.assign(new Error(`${fail[path]}: failed`), {
        code: fail[path],
      });
    return readFileBuffer(path);
  };
  return { fs, reads };
}

describe("grep file errors", () => {
  it("reports the real errno text instead of ENOENT", async () => {
    const { fs } = instrumented({ "/d/a.txt": "x\n" }, { "/d/a.txt": "EFBIG" });
    const env = new Bash({ fs, cwd: "/d" });
    const result = await env.exec("grep x a.txt; cat a.txt");
    expect(result.stderr).toBe(
      "grep: a.txt: File too large\ncat: a.txt: File too large\n",
    );
  });

  it("keeps ENOENT for missing files", async () => {
    const env = new Bash({ cwd: "/" });
    const result = await env.exec("grep x missing.txt");
    expect(result.stderr).toBe(
      "grep: missing.txt: No such file or directory\n",
    );
    expect(result.exitCode).toBe(2);
  });
});

describe("grep early stop", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 120; i++)
    many[`/r/f${String(i).padStart(3, "0")}.txt`] = "hit\n".repeat(3);

  it("-q stops reading after the batch with the first match", async () => {
    const { fs, reads } = instrumented(many);
    const env = new Bash({ fs, cwd: "/r" });
    const result = await env.exec("grep -rq hit /r");
    expect(result.exitCode).toBe(0);
    expect(reads.length).toBeLessThanOrEqual(50);
  });

  it("-l lists each matching file once", async () => {
    const env = new Bash({
      files: { "/r/a": "hit\nhit\n", "/r/b": "no\n", "/r/c": "x\nhit\n" },
      cwd: "/r",
    });
    const result = await env.exec("grep -rl hit /r; grep -rL hit /r");
    expect(result.stdout).toBe("/r/a\n/r/c\n/r/b\n");
  });
});
