import { describe, expect, it } from "vitest";
import {
  ExecutionOutputAccumulator,
  outputSegments,
} from "./execution-output.js";
import { ExecutionScope } from "./execution-scope.js";
import { resolveLimits } from "./limits.js";
import {
  inheritOutputOrigin,
  mergeOutputOrigins,
  outputOrigin,
} from "./output-provenance.js";
import type { ExecResult, OutputSegment } from "./types.js";

describe("output segment identity", () => {
  it("keeps equal text from different producers separate", () => {
    const first: ExecResult = { stdout: "same", stderr: "", exitCode: 0 };
    const second: ExecResult = { stdout: "same", stderr: "", exitCode: 0 };
    const source = outputSegments(first)[0];
    const emitted = inheritOutputOrigin(source, [...source]);
    const merged = mergeOutputOrigins(
      [...outputSegments(first), ...outputSegments(second)],
      [emitted],
    );
    expect(merged).toEqual([
      ["stdout", "same", "text"],
      ["stdout", "same", "text"],
    ]);
  });

  it("preserves producer order through accumulated results", () => {
    const a: OutputSegment = ["stdout", "a", "text"];
    const b: OutputSegment = ["stdout", "b", "text"];
    const c: OutputSegment = ["stdout", "c", "text"];
    for (const part of [a, b, c]) outputOrigin(part);
    const retained = new ExecutionOutputAccumulator(
      new ExecutionScope(resolveLimits()),
      "fixture",
    );
    for (const part of [a, c])
      retained.appendResult({
        stdout: part[1],
        stderr: "",
        exitCode: 0,
        internalOutputSegments: [part],
      });
    expect(
      mergeOutputOrigins(outputSegments(retained.build(0)), [b])
        .map((part) => part[1])
        .join(""),
    ).toBe("abc");
  });
});
