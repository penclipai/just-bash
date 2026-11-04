import { describe, expect, it } from "vitest";
import {
  advanceFd,
  closeFd,
  dupFd,
  getFdEntry,
  moveFd,
  restoreFds,
  setFdEntry,
  snapshotFds,
} from "./fd-table.js";
import type { InterpreterContext } from "./types.js";

function createCtx(): InterpreterContext {
  const ctx = {
    state: { fileDescriptors: new Map<number, string>() },
    limits: { maxFileDescriptors: 8 },
  } as unknown as InterpreterContext;
  setFdEntry(ctx, 1, {
    kind: "readwrite",
    path: "/file",
    position: 0,
    content: "ab",
  });
  return ctx;
}

describe("fd snapshot description identity", () => {
  it("retains nested offsets after all aliases close", () => {
    const ctx = createCtx();
    const outer = snapshotFds(ctx, [1]);
    dupFd(ctx, 3, 1);
    closeFd(ctx, 1);
    const inner = snapshotFds(ctx, [3]);
    closeFd(ctx, 3);
    restoreFds(ctx, inner);
    advanceFd(ctx, 3, 1);
    closeFd(ctx, 3);
    restoreFds(ctx, outer);

    expect(getFdEntry(ctx, 1)).toEqual({
      kind: "readwrite",
      path: "/file",
      position: 1,
      content: "ab",
    });
  });

  it("retains the offset when the last alias moves", () => {
    const ctx = createCtx();
    const snapshot = snapshotFds(ctx, [1]);
    dupFd(ctx, 3, 1);
    closeFd(ctx, 1);
    moveFd(ctx, 4, 3);
    advanceFd(ctx, 4, 1);
    closeFd(ctx, 4);
    restoreFds(ctx, snapshot);

    expect(getFdEntry(ctx, 1)).toEqual({
      kind: "readwrite",
      path: "/file",
      position: 1,
      content: "ab",
    });
  });
});
