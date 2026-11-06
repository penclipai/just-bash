import type { CommandByteIO } from "../../byte-io.js";
import { utf8ByteLength } from "../../encoding.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";
import type { AwkRuntimeContext } from "./interpreter/context.js";

export type AwkDefense = <T>(
  phase: string,
  operation: () => Promise<T>,
) => Promise<T>;

/** Drain only original evaluator output; its formatter and control flow stay. */
export class AwkStreamOutput {
  private runtime: AwkRuntimeContext;
  private command: RuntimeCommandContext;
  private defense: AwkDefense;
  private maximum: number;
  private bytes = 0;
  private pendingBytes = 0;
  private pendingCharacters = 0;
  private trailingHigh = false;
  constructor(
    runtime: AwkRuntimeContext,
    command: RuntimeCommandContext,
    defense: AwkDefense,
  ) {
    this.runtime = runtime;
    this.command = command;
    this.defense = defense;
    this.maximum = runtime.maxOutputSize;
  }

  async drain(force = false): Promise<void> {
    const text = this.runtime.output;
    if (!text) return;
    const overlap = Number(this.trailingHigh);
    this.pendingBytes +=
      utf8ByteLength(text.slice(this.pendingCharacters - overlap)) -
      overlap * 3;
    this.pendingCharacters = text.length;
    const tail = text.charCodeAt(text.length - 1);
    this.trailingHigh = tail >= 0xd800 && tail <= 0xdbff;
    if (this.maximum > 0 && this.pendingBytes > this.maximum - this.bytes)
      throw new ExecutionLimitError(
        `awk: output size limit exceeded (${this.maximum} bytes)`,
        "output_size",
      );
    if (!force && text.length < 16_384) return;
    // A later printf/print may complete this UTF-16 pair. Keep that one code
    // unit until more output or the command's final returned tail arrives.
    const limit = text.length - Number(this.trailingHigh);
    for (let start = 0; start < limit; ) {
      let end = Math.min(limit, start + 16_384);
      const last = text.charCodeAt(end - 1);
      if (end < limit && last >= 0xd800 && last <= 0xdbff) end--;
      const lease = this.command.executionScope?.reserveBytes(
        "awk output block",
        (end - start) * 4,
        "awk",
      );
      try {
        const piece = text.slice(start, end);
        await this.defense("stream output", () =>
          this.command.writeOutput
            ? this.command.writeOutput(piece, "stdout", "text")
            : (this.command.byteIO as CommandByteIO).stdout.write(
                new TextEncoder().encode(piece),
                this.command.signal,
              ),
        );
        const size = utf8ByteLength(piece);
        this.bytes += size;
        this.pendingBytes -= size;
        this.runtime.output = text.slice(end);
        this.pendingCharacters = this.runtime.output.length;
      } finally {
        lease?.release();
      }
      start = end;
    }
  }
}
