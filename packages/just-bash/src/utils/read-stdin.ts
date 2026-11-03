import type { ByteString } from "../encoding.js";
import type { RuntimeCommandContext } from "../types.js";

/** Standalone command callers retain the original buffered stdin contract. */
export function readStdin(ctx: RuntimeCommandContext): Promise<ByteString> {
  return ctx.readStdin ? ctx.readStdin() : Promise.resolve(ctx.stdin);
}
