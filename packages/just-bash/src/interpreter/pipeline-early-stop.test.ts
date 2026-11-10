import { describe, expect, it } from "vitest";
import { defineCommand } from "../custom-commands.js";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { consumerPrefix } from "./pipeline-early-stop.js";

function instrumented(files: Record<string, string>) {
  const fs = new InMemoryFs(files);
  const reads: string[] = [];
  const readFileBuffer = fs.readFileBuffer.bind(fs);
  fs.readFileBuffer = async (path: string) => {
    reads.push(path);
    return readFileBuffer(path);
  };
  return { fs, reads };
}

const many: Record<string, string> = {};
for (let i = 0; i < 200; i++)
  many[`/r/f${String(i).padStart(3, "0")}.txt`] =
    `hit ${i} a\nmiss\nhit ${i} b\n`;
const all = Object.keys(many).sort();

async function both(script: string, files = many) {
  const fast = instrumented(files);
  const result = await new Bash({ fs: fast.fs, cwd: "/r" }).exec(script);
  // `| cat` in between disables the early stop: the reference output.
  const slow = await new Bash({ fs: new InMemoryFs(files), cwd: "/r" }).exec(
    script.replace(" | ", " | cat | "),
  );
  return { result, slow, reads: fast.reads };
}

describe("consumerPrefix", () => {
  it.each([
    [[], { lines: 10 }],
    [["-5"], { lines: 5 }],
    [["-n", "20"], { lines: 20 }],
    [["-n3"], { lines: 3 }],
    [["--lines=7"], { lines: 7 }],
    [["-c", "9"], { bytes: 9 }],
    [["-c9"], { bytes: 9 }],
    [["--bytes=4"], { bytes: 4 }],
    [["-q", "-n", "2", "-"], { lines: 2 }],
  ])("head %j", (args, expected) => {
    const got = consumerPrefix(args, "head");
    expect({ lines: got?.lines, bytes: got?.bytes }).toEqual({
      lines: undefined,
      bytes: undefined,
      ...expected,
    });
  });

  it.each([
    [["file"]],
    [["-n", "-5"]],
    [["-n", "+5"]],
    [["-n", "1k"]],
    [["-c", "-3"]],
    [["-z"]],
  ])("head %j is not a known prefix", (args) => {
    expect(consumerPrefix(args, "head")).toBeUndefined();
  });

  it("sed print ranges and quit", () => {
    expect(consumerPrefix(["-n", "1,20p"], "sed")).toEqual({ lines: 20 });
    expect(consumerPrefix(["-n", "5p"], "sed")).toEqual({ lines: 5 });
    expect(consumerPrefix(["3q"], "sed")).toEqual({ lines: 3 });
    expect(consumerPrefix(["-n", "20,1p"], "sed")).toBeUndefined();
    expect(consumerPrefix(["-n", "1,$p"], "sed")).toBeUndefined();
    expect(consumerPrefix(["s/a/b/"], "sed")).toBeUndefined();
    expect(consumerPrefix(["-n", "1,5p", "file"], "sed")).toBeUndefined();
  });
});

describe("pipeline early stop", () => {
  it.each([
    "grep -rn hit . | head -20",
    "grep -rn hit . | head",
    "grep -r hit /r | head -n 3",
    "grep -rh hit . | head -c 25",
    "grep -rn hit . | sed -n '1,7p'",
    "grep -rn hit . | sed -n '4p'",
    "grep -rn hit . | sed 2q",
  ])("%s keeps output and reads a prefix", async (script) => {
    const { result, slow, reads } = await both(script);
    expect(result.stdout).toBe(slow.stdout);
    expect(result.exitCode).toBe(slow.exitCode);
    expect(reads.length).toBeLessThan(all.length / 4);
  });

  it("offers a prefix only to literal git grep", async () => {
    const observed: boolean[] = [];
    const git = defineCommand("git", async (_args, ctx) => {
      observed.push(!!ctx.stdoutLimit);
      const stdout = "one\ntwo\n";
      if (ctx.stdoutLimit?.reached(stdout)) ctx.stdoutLimit.stop();
      return { stdout, stderr: "", exitCode: 0 };
    });
    const bash = new Bash({ customCommands: [git] });
    const result = await bash.exec(
      'git grep pat | head -1; echo "${PIPESTATUS[@]}"',
    );
    expect(result.stdout).toBe("one\n141 0\n");
    await bash.exec('verb=grep; git "$verb" pat | head -1');
    await bash.exec("git add file | head -1");
    await bash.exec("git grep pat");
    expect(observed).toEqual([true, false, false, false]);
  });
  it("cat of many files stops after the prefix", async () => {
    const script = `cat ${all.join(" ")} | head -5`;
    const { result, slow, reads } = await both(script);
    expect(result.stdout).toBe(slow.stdout);
    expect(reads.length).toBe(2);
  });

  it("reports SIGPIPE for the stopped producer only", async () => {
    const env = new Bash({ files: many, cwd: "/r" });
    const stopped = await env.exec(
      'grep -rn hit . | head -1; echo "${PIPESTATUS[@]}"',
    );
    expect(stopped.stdout).toBe("./f000.txt:1:hit 0 a\n141 0\n");
    const short = await env.exec(
      'grep -rn "hit 5 " . | head -10; echo "${PIPESTATUS[@]}"',
    );
    expect(short.stdout).toBe(
      "./f005.txt:1:hit 5 a\n./f005.txt:3:hit 5 b\n0 0\n",
    );
  });

  it.each([
    ["pipefail", "set -o pipefail; grep -rn hit . | head -2"],
    [
      "a function head",
      'head() { command head "$@"; }; grep -rn hit . | head -2',
    ],
    [
      "a function producer",
      'grep() { command grep "$@"; }; grep -rn hit . | head -2',
    ],
    [
      "an alias",
      "shopt -s expand_aliases; alias head='head -n 50'\ngrep -rn hit . | head -2",
    ],
    ["producer stdout redirection", "grep -rn hit . >/dev/null | head -2"],
    ["producer 1>&2", "grep -rn hit . 1>&2 | head -2"],
    ["consumer file", "grep -rn hit . | head -2 /r/f001.txt"],
    ["consumer stdin redirection", "grep -rn hit . | head -2 < /r/f001.txt"],
    ["variable limit", "n=2; grep -rn hit . | head -n $n"],
    ["head -n -N", "grep -rn hit . | head -n -2"],
    ["three stages", "grep -rn hit . | sort | head -2"],
    ["|&", "grep -rn hit . |& head -2"],
  ])("does not stop with %s", async (_label, script) => {
    const { fs, reads } = instrumented(many);
    const result = await new Bash({ fs, cwd: "/r" }).exec(script);
    const reference = await new Bash({
      fs: new InMemoryFs(many),
      cwd: "/r",
    }).exec(script);
    expect(result.stdout).toBe(reference.stdout);
    if (_label !== "three stages") expect(new Set(reads).size).toBe(all.length);
  });

  it.each([
    "grep -rn $(echo hit) . | head -3",
    "grep -rn hit . 2>/dev/null | head -3",
    "grep -rn hit . 2>&1 | head -3",
    "cat $(grep -rl hit . | sort) | head -3",
  ])("%s still stops", async (script) => {
    const { result, slow, reads } = await both(script);
    expect(result.stdout).toBe(slow.stdout);
    expect(reads.length).toBeLessThan(all.length * 2);
  });

  it("a command in the producer's substitution never takes the limit", async () => {
    const env = new Bash({ files: many, cwd: "/r" });
    const result = await env.exec(
      'cat $(cat /r/f000.txt >/dev/null; echo /r/f001.txt) | head -1; echo "${PIPESTATUS[@]}"',
    );
    expect(result.stdout).toBe("hit 1 a\n141 0\n");
  });

  it("an empty producer still reaches head", async () => {
    const { result, slow } = await both("grep -rn nothing . | head -3");
    expect(result.stdout).toBe(slow.stdout);
    expect(result.stdout).toBe("");
  });
});
