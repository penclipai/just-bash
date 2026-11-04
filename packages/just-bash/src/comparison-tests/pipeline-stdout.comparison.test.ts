import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("pipeline stdout before inherited descriptors", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("transforms pipeline output before process capture", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "cat <(printf 'a\\n' | tr -d '\\n'; printf '\\n')",
      { compareStderr: true },
    );
  });

  it("transforms pipeline output before a persistent redirect", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "exec 3>&1; exec > out; printf 'a\\n' | tr -d '\\n'; printf '\\n'; exec 1>&3; cat out",
      { compareStderr: true },
    );
  });

  it("applies implicit stderr duplication after simple redirects", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "f() { printf o; printf e >&2; }; f >side 2>error |& cat; printf '<'; cat error; printf '>'; cat side",
      { compareStderr: true },
    );
  });

  it("applies implicit stderr duplication after group redirects", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "{ printf o; printf e >&2; } >side |& cat; cat side",
      { compareStderr: true },
    );
  });

  it("replaces inherited capture stderr for a merged pipe", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "cat <(exec 2>&1; { printf o; printf e >&2; } |& tr oe OE)",
      { compareStderr: true },
    );
  });

  it("keeps failed redirect diagnostics outside a merged pipe", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "printf x >missing/out |& wc -c");
  });

  it("retains a shared stdout offset after a pipeline", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "printf '' >file; exec 4>&1; exec 1<>file; exec 3>&1; printf a >&3 | cat; printf b; exec 1>&4; cat file",
      { compareStderr: true },
    );
  });

  it("retains stdout when its alias is reopened in a pipeline", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "printf '' >file; printf z >other; exec 4>&1; exec 1<>file; exec 3>&1; { printf a >&3; exec 3<>other; } | cat; printf b; exec 1>&4; cat file; cat other",
      { compareStderr: true },
    );
  });

  it("keeps a prepared readwrite target after FD reuse", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      ": >file; : >other; exec 3<>file; f() { exec 3>&-; exec 3<>other; printf a; }; f >&3; printf 'original:['; cat file; printf '] reopened:['; cat other; printf ']\\n'",
      { compareStderr: true },
    );
  });
});
