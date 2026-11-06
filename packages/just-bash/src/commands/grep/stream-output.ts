import { utf8ByteLength } from "../../encoding.js";
import type { ResourceLease } from "../../execution-scope.js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { RuntimeCommandContext } from "../../types.js";

/** Batch small selected lines; all streaming output is published exactly once. */
export class GrepOutput {
  private ctx: RuntimeCommandContext;
  private pending = "";
  private output: string[] = [];
  private leases: ResourceLease[] = [];
  private retained: ResourceLease[] = [];
  private bytes = 0;
  constructor(ctx: RuntimeCommandContext) {
    this.ctx = ctx;
  }

  async append(text: string): Promise<void> {
    const size = utf8ByteLength(text);
    if (size > this.ctx.limits.maxOutputSize - this.bytes)
      throw new ExecutionLimitError(
        "grep: output size limit exceeded",
        "output_size",
      );
    this.bytes += size;
    for (let start = 0; start < text.length; ) {
      let end = Math.min(text.length, start + 16_384);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      const piece = text.slice(start, end);
      if (this.pending.length + piece.length > 16_384) await this.flush();
      const lease = this.ctx.executionScope?.reserveBytes(
        "grep pending output",
        piece.length * 4,
        "grep",
      );
      if (lease) this.leases.push(lease);
      this.pending += piece;
      start = end;
      if (this.pending.length >= 16_384) await this.flush();
    }
  }
  async flush(): Promise<void> {
    if (!this.pending) return;
    if (this.ctx.writeOutput)
      await this.ctx.writeOutput(this.pending, "stdout", "text");
    else if (this.ctx.byteIO)
      await this.ctx.byteIO.stdout.write(
        new TextEncoder().encode(this.pending),
        this.ctx.signal,
      );
    else {
      this.output.push(this.pending);
      this.retained.push(...this.leases.splice(0));
    }
    this.pending = "";
    for (const lease of this.leases.splice(0)) lease.release();
  }
  async finish(): Promise<string> {
    await this.flush();
    return this.output.join("");
  }
  close(): void {
    for (const lease of [...this.leases, ...this.retained]) lease.release();
  }
}
