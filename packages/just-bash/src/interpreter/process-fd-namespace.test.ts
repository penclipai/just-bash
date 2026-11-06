import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getFileSystemIdentity } from "../fs/identity.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import {
  registerOutputFileAppender,
  registerOutputFileWriter,
  tryAppendOutputFile,
  writeOutputFile,
} from "../fs/output-write.js";
import { OverlayFs } from "../fs/overlay-fs/index.js";
import { createProcessFdNamespace } from "./process-fd-namespace.js";
import type { ProcessSubstitutionEntry } from "./process-substitution.js";
import type { InterpreterState } from "./types.js";
import { rebindShellFileSystem } from "./umask-fs.js";

const state = (entries: ProcessSubstitutionEntry[] = []) =>
  ({ processSubstitutions: entries }) as InterpreterState;
const entry = (fd: number): ProcessSubstitutionEntry => ({
  fd,
  path: `/dev/fd/${fd}`,
  direction: "input",
  body: { type: "Script", statements: [] },
});

describe("managed process descriptor namespaces", () => {
  it("resolves preseeded and indirect descriptor aliases", async () => {
    const base = new InMemoryFs();
    await base.symlink("/dev/fd", "/alias");
    const current = state();
    const fs = createProcessFdNamespace(
      createProcessFdNamespace(base, state()),
      current,
    );
    current.processSubstitutions?.push(entry(63));
    await fs.writeFile("/dev/fd/63", "A");
    expect(await fs.readFile("/alias/63")).toBe("A");
    await fs.symlink("/alias", "/alias2");
    expect(await fs.readFile("/alias2/63")).toBe("A");
  });
  it("resolves private alias writes before their effects", async () => {
    const base = new InMemoryFs();
    await base.symlink("/dev/fd", "/alias");
    const current = state();
    const fs = createProcessFdNamespace(
      createProcessFdNamespace(base, state()),
      current,
    );
    current.processSubstitutions?.push(entry(63));
    await fs.writeFile("/dev/fd/63", "A");
    await fs.writeFile("/alias/63", "B");
    expect(await fs.readFile("/dev/fd/63")).toBe("B");
    expect(await base.exists("/dev/fd/63")).toBe(false);
    expect(base.getAllPaths()).not.toContain("/alias/63");
  });
  it("resolves aliases created after sibling namespaces fork", async () => {
    const parent = createProcessFdNamespace(new InMemoryFs(), state());
    const left = createProcessFdNamespace(parent, state());
    const rightState = state();
    const right = createProcessFdNamespace(parent, rightState);
    rightState.processSubstitutions?.push(entry(63));
    await right.writeFile("/dev/fd/63", "B");
    await left.symlink("/dev/fd", "/alias");
    expect((await right.lstat("/alias/63")).size).toBe(1);
    expect(await right.readFile("/alias/63")).toBe("B");
  });
  it("isolates new paths and keeps inherited backing live", async () => {
    const base = new InMemoryFs();
    const parentState = state();
    const parent = createProcessFdNamespace(base, parentState);
    parentState.processSubstitutions?.push(entry(63));
    await parent.writeFile("/dev/fd/63", "parent");
    const leftState = state(parentState.processSubstitutions?.slice());
    const rightState = state(parentState.processSubstitutions?.slice());
    const left = createProcessFdNamespace(parent, leftState);
    const right = createProcessFdNamespace(parent, rightState);
    leftState.processSubstitutions?.push(entry(62));
    rightState.processSubstitutions?.push(entry(62));
    await left.writeFile("/dev/fd/62", "left");
    await right.writeFile("/dev/fd/62", "right");
    expect(await left.readFile("/dev/fd/62")).toBe("left");
    expect(await right.readFile("/dev/fd/62")).toBe("right");
    await left.appendFile("/dev/fd/63", " live");
    expect(await right.readFile("/dev/fd/63")).toBe("parent live");
    await left.rm("/dev/fd/62");
    leftState.processSubstitutions?.pop();
    expect(await left.readdir("/dev/fd")).toEqual(["63"]);
    expect(await right.readFile("/dev/fd/62")).toBe("right");
    const rebound = rebindShellFileSystem(
      right,
      state(rightState.processSubstitutions?.slice()),
    );
    expect(await rebound.readFile("/dev/fd/62")).toBe("right");
    expect(getFileSystemIdentity(rebound)).toBe(getFileSystemIdentity(base));
    expect("openByteReader" in rebound).toBe("openByteReader" in base);
  });

  it("routes copies and aliases without sharing scratch writes", async () => {
    const base = new InMemoryFs();
    const current = state();
    const fs = createProcessFdNamespace(
      createProcessFdNamespace(base, state()),
      current,
    );
    current.processSubstitutions?.push(entry(63));
    await fs.writeFile("/dev/fd/63", "A");
    await fs.cp("/dev/fd/63", "/out");
    await fs.writeFile("/dev/fd/99", "ordinary");
    await fs.symlink("/dev/fd/63", "/alias");
    expect(await fs.readFile("/alias")).toBe("A");
    await fs.writeFile("/dev/fd/63", "B");
    expect(await fs.readFile("/alias")).toBe("B");
    await expect(fs.link("/dev/fd/63", "/link")).rejects.toThrow("EXDEV");
    expect(await base.exists("/link")).toBe(false);
    await fs.mv("/dev/fd/63", "/moved");
    current.processSubstitutions?.pop();
    expect(await base.readFile("/out")).toBe("A");
    expect(await base.readFile("/moved")).toBe("B");
    expect(await base.readFile("/dev/fd/99")).toBe("ordinary");
    expect(await fs.readdir("/dev/fd")).toEqual(["99"]);
    expect(await fs.exists("/dev/fd")).toBe(true);
    expect((await fs.stat("/dev/fd")).isDirectory).toBe(true);
  });

  it("preserves read-only policy outside allocated descriptors", async () => {
    const base = new OverlayFs({
      root: path.join(import.meta.dirname, "..", "comparison-tests"),
      readOnly: true,
    });
    const current = state();
    const fs = createProcessFdNamespace(
      createProcessFdNamespace(base, state()),
      current,
    );
    current.processSubstitutions?.push(entry(63));
    await fs.writeFile("/dev/fd/63", "allowed");
    expect(await fs.readFile("/dev/fd/63")).toBe("allowed");
    await expect(fs.writeFile("/dev/fd/99", "denied")).rejects.toThrow("EROFS");
    await expect(fs.cp("/dev/fd/63", "/out")).rejects.toThrow("EROFS");
    await expect(fs.mkdir("/dev/fd/sub")).rejects.toThrow("EROFS");
    await fs.rm("/dev/fd/63");
    current.processSubstitutions?.pop();
    expect(await fs.readdir("/dev/fd")).toEqual([]);
    await expect(fs.appendFile("/dev/fd/99", "denied")).rejects.toThrow(
      "EROFS",
    );
  });

  it("follows ancestor aliases without following the leaf", async () => {
    const current = state();
    const fs = createProcessFdNamespace(
      createProcessFdNamespace(new InMemoryFs(), state()),
      current,
    );
    current.processSubstitutions?.push(entry(63), entry(62));
    await fs.writeFile("/dev/fd/63", "A");
    await fs.symlink("/dev/fd", "/alias");
    await fs.symlink("63", "/dev/fd/62");
    expect((await fs.lstat("/alias/63")).isFile).toBe(true);
    expect((await fs.lstat("/alias/62")).isSymbolicLink).toBe(true);
    expect(await fs.readlink("/alias/62")).toBe("63");
    await fs.rm("/alias/62");
    expect(await fs.exists("/dev/fd/62")).toBe(false);
    expect(await fs.readFile("/alias/63")).toBe("A");
  });

  it("retains the root backend's copied-link capability", async () => {
    const base = new InMemoryFs({ "/x": "1234" });
    const current = state();
    const fs = createProcessFdNamespace(base, current);
    current.processSubstitutions?.push(entry(63));
    await fs.writeFile("/dev/fd/63", "abcd");
    await fs.link("/dev/fd/63", "/alias");
    expect((await fs.stat("/alias")).identity).toBe(
      (await fs.stat("/dev/fd/63")).identity,
    );
    await fs.cp("/x", "/alias");
    expect(await fs.readFile("/dev/fd/63")).toBe("abcd");
    expect(await base.readFile("/alias")).toBe("1234");
  });

  it("keeps delegated output provenance and append admission", async () => {
    const base = new InMemoryFs();
    const provenance = { writtenBytes: 1, previousSize: 0, retainedBytes: 0 };
    let seen: unknown;
    registerOutputFileWriter(
      base,
      async (kind, path, content, options, origin) => {
        seen = origin;
        await base[kind](path, content, options);
      },
    );
    registerOutputFileAppender(base, async () => true);
    const fs = createProcessFdNamespace(base, state());
    await writeOutputFile(fs, "writeFile", "/out", "A", "utf8", provenance);
    expect(seen).toBe(provenance);
    expect(await base.readFile("/out")).toBe("A");
    expect(await tryAppendOutputFile(fs, "/out", 1, "B")).toBe(true);
  });
});
