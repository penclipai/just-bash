import type { ByteReader } from "../../byte-io.js";
import { utf8ByteLength } from "../../encoding.js";
import { rethrowFatalExecutionError } from "../../fatal-execution-error.js";
import {
  ExecutionAbortedError,
  ExecutionLimitError,
} from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import { accountFileInput } from "../../utils/file-reader.js";
import { fsErrorMessage } from "../../utils/fs-error.js";
import { readTextLines } from "../../utils/stream-lines.js";
import type { AwkProgram } from "./ast.js";
import type { AwkRuntimeContext } from "./interpreter/context.js";
import { type AwkDefense, AwkStreamOutput } from "./stream-output.js";
import { canStreamAwk } from "./stream-plan.js";

interface CurrentFile {
  reader: ByteReader;
  lines: AsyncGenerator<{ value: string; terminated: boolean }>;
  base: number;
  raw: number;
  decoded: number;
  records: number;
}

class AwkStreamInput {
  private runtime: AwkRuntimeContext;
  private command: RuntimeCommandContext;
  private files: readonly string[];
  private defense: AwkDefense;
  private onBlock: () => Promise<void>;
  private current?: CurrentFile;
  private next = 0;
  constructor(
    runtime: AwkRuntimeContext,
    command: RuntimeCommandContext,
    files: readonly string[],
    defense: AwkDefense,
    onBlock: () => Promise<void>,
  ) {
    this.runtime = runtime;
    this.command = command;
    this.files = files;
    this.defense = defense;
    this.onBlock = onBlock;
    runtime.inputLimit = Math.min(
      command.limits.maxInputBytes,
      command.limits.maxStringLength,
    );
    runtime.inputBytes = 0;
    runtime.readMain = () => this.read();
  }

  private check(): void {
    this.command.executionScope?.throwIfAborted("awk");
    if (this.command.signal?.aborted) throw new ExecutionAbortedError();
  }
  private limit(): never {
    throw new ExecutionLimitError(
      `aggregate input size limit exceeded (${this.runtime.inputLimit} bytes)`,
      "string_length",
    );
  }
  private async open(): Promise<void> {
    const name = this.files[this.next++];
    const path = this.command.fs.resolvePath(this.command.cwd, name);
    try {
      const stat = await this.defense("stream input stat", () =>
        this.command.fs.stat(path),
      );
      if (stat.size > this.runtime.inputLimit - this.runtime.inputBytes)
        this.limit();
      accountFileInput(this.command, stat.size, "awk");
      const open = this.command.fs.openByteReader as NonNullable<
        typeof this.command.fs.openByteReader
      >;
      const reader = await this.defense("stream input open", () =>
        open.call(this.command.fs, path),
      );
      this.current = {
        reader,
        lines: readTextLines(
          reader,
          this.command,
          false,
          stat.size,
          this.onBlock,
          "awk",
        ),
        base: this.runtime.inputBytes,
        raw: stat.size,
        decoded: 0,
        records: 0,
      };
      if (reader.size !== undefined && reader.size > stat.size) this.limit();
      this.runtime.inputBytes += stat.size;
      this.runtime.FILENAME = name;
      this.runtime.FNR = 0;
      this.check();
    } catch (error) {
      rethrowFatalExecutionError(error);
      this.check();
      throw new Error(`${name}: ${fsErrorMessage(error)}`);
    }
  }
  private async read(): Promise<string | null> {
    for (;;) {
      this.check();
      if (!this.current) {
        if (this.next === this.files.length) return null;
        await this.open();
      }
      const current = this.current as CurrentFile;
      const next = await current.lines.next();
      if (next.done) {
        await this.close();
        this.runtime.inputBytes = current.base + current.decoded;
        continue;
      }
      current.decoded +=
        utf8ByteLength(next.value.value) + Number(next.value.terminated);
      const logical = Math.max(current.raw, current.decoded);
      if (logical > this.runtime.inputLimit - current.base) this.limit();
      this.runtime.inputBytes = current.base + logical;
      if (++current.records > this.runtime.maxArrayElements)
        throw new ExecutionLimitError(
          `record array limit exceeded (${this.runtime.maxArrayElements})`,
          "array_elements",
        );
      this.runtime.RT = next.value.terminated ? "\n" : "";
      return next.value.value;
    }
  }
  async close(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) {
      this.check();
      return;
    }
    let failure: { error: unknown } | undefined;
    try {
      await this.defense("stream line cleanup", () =>
        current.lines.return(undefined),
      );
    } catch (error) {
      failure = { error };
    }
    try {
      await this.defense("stream input close", () => current.reader.close());
    } catch (error) {
      failure ??= { error };
    }
    if (failure) throw failure.error;
    this.check();
  }
}

export function createAwkStream(
  program: AwkProgram,
  runtime: AwkRuntimeContext,
  command: RuntimeCommandContext,
  files: readonly string[],
  defense: AwkDefense,
): { drain(): Promise<void>; close(): Promise<void> } | undefined {
  if (!canStreamAwk(program, runtime, command, files)) return;
  const output = new AwkStreamOutput(runtime, command, defense);
  const input = new AwkStreamInput(runtime, command, files, defense, () =>
    output.drain(true),
  );
  return { drain: () => output.drain(), close: () => input.close() };
}
