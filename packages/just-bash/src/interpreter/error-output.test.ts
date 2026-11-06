import { describe, expect, it } from "vitest";
import { prependOutputFrom } from "../execution-output.js";
import type { ExecResult, OutputSegment } from "../types.js";
import {
  appendRelayedErrorOutput,
  inheritErrorOutput,
  resolveErrorOutput,
  seedRelayedErrorOutput,
} from "./error-output.js";
import { ErrexitError, ExitError } from "./errors.js";

describe("control-flow error output origins", () => {
  it("keeps identical fresh and relayed output separate", async () => {
    const error = new ExitError(7, "", "same\n");
    prependOutputFrom(error, {
      stdout: "same\n",
      stderr: "same\n",
      internalOutputSegments: [
        ["stderr", "same\n", "text"],
        ["stdout", "same\n", "text"],
      ],
    });
    error.prependOutput("same\n", "");
    appendRelayedErrorOutput(error, {
      stdout: "\xff",
      stdoutKind: "bytes",
      stderr: "",
      internalOutputAccounting: { stdout: 1, stderr: 0 },
    });
    const seen: Array<[OutputSegment, number]> = [];
    const route = async (
      part: OutputSegment,
      accounted: number,
    ): Promise<ExecResult> => {
      seen.push([part, accounted]);
      return { stdout: "", stderr: "", exitCode: 7 };
    };
    await resolveErrorOutput(error, route);
    await resolveErrorOutput(error, route);
    expect(seen).toEqual([
      [["stdout", "same\n", "text"], 5],
      [["stderr", "same\n", "text"], 0],
    ]);
    expect(error.stdout).toBe("same\n\xff");
    expect(error.stderr).toBe("same\n");
    expect(error.internalOutputSegments).toEqual([
      ["stderr", "same\n", "text"],
      ["stdout", "same\n", "text"],
      ["stdout", "\xff", "bytes"],
    ]);
    expect(error.internalOutputAccounting).toEqual({ stdout: 6, stderr: 5 });
  });

  it("preserves origins when a fatal error is wrapped", async () => {
    const source = new ExitError(1, "", "diagnostic\n");
    prependOutputFrom(source, { stdout: "child\n", stderr: "" });
    const wrapped = new ExitError(1);
    inheritErrorOutput(wrapped, source);
    const seen: OutputSegment[] = [];
    await resolveErrorOutput(wrapped, async (part) => {
      seen.push(part);
      return {
        stdout: part[1],
        stderr: "",
        exitCode: 1,
        internalOutputAccounting: { stdout: part[1].length, stderr: 0 },
      };
    });
    expect(seen).toEqual([["stderr", "diagnostic\n", "text"]]);
    expect(wrapped.stdout).toBe("child\ndiagnostic\n");
    expect(wrapped.stderr).toBe("");
    expect(source.stderr).toBe("diagnostic\n");
  });

  it("does not reroute errors created from routed results", async () => {
    const error = new ErrexitError(9);
    seedRelayedErrorOutput(error, {
      stdout: "\xff",
      stdoutKind: "bytes",
      stderr: "é",
      internalOutputAccounting: { stdout: 1, stderr: 2 },
    });
    await resolveErrorOutput(error, async () => {
      throw new Error("already-routed output must not reach this callback");
    });
    expect(error.stdout).toBe("\xff");
    expect(error.stderr).toBe("é");
    expect(error.internalOutputAccounting).toEqual({ stdout: 1, stderr: 2 });
  });

  it("handles segments beyond the call argument limit", async () => {
    const count = 150_000;
    const text = "x".repeat(count);
    const source: ExecResult = {
      stdout: text,
      stderr: "",
      exitCode: 0,
      internalOutputSegments: Array.from({ length: count }, () => [
        "stdout",
        "x",
        "text",
      ]),
      internalOutputAccounting: { stdout: count, stderr: 0 },
    };
    const error = new ExitError(1, "", "diagnostic\n");
    prependOutputFrom(error, source);
    appendRelayedErrorOutput(error, source);
    await resolveErrorOutput(error, async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    }));
    expect(error.stdout).toBe(text + text);
    expect(error.stderr).toBe("");
    expect(error.internalOutputSegments).toHaveLength(count * 2);
    expect(error.internalOutputAccounting).toEqual({
      stdout: count * 2,
      stderr: 0,
    });
  });
});
