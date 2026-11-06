import { BYTE_IO_BLOCK_BYTES, type ByteWriter } from "../byte-io.js";
import { utf8ByteLength } from "../encoding.js";
import type { ExecutionScope } from "../execution-scope.js";
import type { OutputSegment } from "../types.js";
import type { BytePipe } from "./byte-pipe.js";
import {
  descriptionClosed,
  registerDescriptionLifetime,
} from "./description-lifetime.js";
import { type FdEntry, setFdEntry } from "./fd-table.js";
import type { OutputEndpoint, OutputEndpoints } from "./output-endpoints.js";
import type { PreparedRedirections } from "./redirections.js";
import type { InterpreterContext } from "./types.js";

export type PipeCommandOutputs = Partial<
  Record<"stdout" | "stderr", ByteWriter>
>;
const writers = new WeakMap<OutputEndpoint, ByteWriter>();

export function isPipeOutputEndpoint(endpoint: OutputEndpoint): boolean {
  return writers.has(endpoint);
}

export function installOutputDescriptions(
  ctx: InterpreterContext,
  fds: readonly number[] = [1, 2],
  endpoints: OutputEndpoints | undefined = ctx.outputEndpoints,
  entries?: ReadonlyMap<number, FdEntry>,
): void {
  for (const [fd, stream] of [
    [1, "stdout"],
    [2, "stderr"],
  ] as const) {
    if (!fds.includes(fd)) continue;
    const entry = entries?.get(fd);
    if (entry && entry.kind !== "output" && entry.kind !== "dup-out") {
      setFdEntry(ctx, fd, entry);
      ctx.state.closedStandardFds?.delete(fd);
      continue;
    }
    const endpoint = endpoints?.[stream];
    if (!endpoint) continue;
    setFdEntry(ctx, fd, {
      kind: "dup-out",
      sourceFd:
        endpoint.stream === "stdout"
          ? 1
          : endpoint.stream === "stderr"
            ? 2
            : fd,
      ...(endpoint.stream ? Object.create(null) : { endpoint }),
    });
    ctx.state.closedStandardFds?.delete(fd);
  }
}

export async function writePipeOutput(
  writer: ByteWriter,
  text: string,
  kind: "text" | "bytes",
  scope: ExecutionScope,
  signal?: AbortSignal,
): Promise<void> {
  const size = kind === "bytes" ? text.length : utf8ByteLength(text);
  const lease = scope.reserveBytes(size, "legacy pipe conversion");
  try {
    const bytes =
      kind === "bytes"
        ? Uint8Array.from(text, (character) => character.charCodeAt(0))
        : new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += BYTE_IO_BLOCK_BYTES)
      await writer.write(
        bytes.subarray(offset, offset + BYTE_IO_BLOCK_BYTES),
        signal,
      );
  } finally {
    lease.release();
  }
}

export function createPipeOutputEndpoint(
  pipe: BytePipe,
  scope: ExecutionScope,
): OutputEndpoint {
  const writer = pipe.writer();
  const endpoint: OutputEndpoint = {
    get closed() {
      return descriptionClosed(endpoint);
    },
    write: (text: string, kind: "text" | "bytes", _origin?: OutputSegment) =>
      writePipeOutput(writer, text, kind, scope),
  };
  registerDescriptionLifetime(endpoint, scope, () => writer.close());
  writers.set(endpoint, writer);
  return endpoint;
}

/** Only real pipe destinations bypass the retained legacy command result. */
export function commandPipeOutputs(
  ctx: InterpreterContext,
  routes: PreparedRedirections["outputRoutes"],
): PipeCommandOutputs | undefined {
  let result: PipeCommandOutputs | undefined;
  for (const stream of ["stdout", "stderr"] as const) {
    const route = routes[stream];
    const endpoint =
      route.kind === "endpoint"
        ? route.endpoint
        : route.kind === "live-stdout"
          ? ctx.outputEndpoints?.stdout
          : route.kind === "live-stderr"
            ? ctx.outputEndpoints?.stderr
            : undefined;
    const writer = endpoint && writers.get(endpoint);
    if (writer) {
      result ??= Object.create(null) as PipeCommandOutputs;
      result[stream] = writer;
    }
  }
  return result;
}
