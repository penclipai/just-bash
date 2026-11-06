import {
  encodeUtf8ToBytes,
  latin1FromBytes,
  readBytesFrom,
  utf8ByteLength,
} from "../encoding.js";
import type { ExecutionScope } from "../execution-scope.js";
import { tryAppendOutputFile, writeOutputFile } from "../fs/output-write.js";
import type { OutputSegment } from "../types.js";
import { ExecutionAbortedError } from "./errors.js";
import { writeFdEntry } from "./fd-table.js";
import type { PreparedRedirections } from "./redirections.js";
import type { InterpreterContext } from "./types.js";

export type OutputEndpoint = {
  readonly closed?: boolean;
  readonly stream?: "stdout" | "stderr";
  readonly path?: string;
  write(
    text: string,
    kind: "text" | "bytes",
    origin?: OutputSegment,
  ): Promise<void>;
};
export type OutputEndpoints = Partial<
  Record<"stdout" | "stderr", OutputEndpoint>
>;
const queues = new WeakMap<ExecutionScope, Promise<unknown>>();

/** All branches serialize effects on their shared open output descriptions. */
export function serializeOutputWrite<T>(
  scope: ExecutionScope,
  write: () => Promise<T>,
): Promise<T> {
  const run = () => {
    if (scope.shellJobs.signal.aborted) throw new ExecutionAbortedError();
    scope.consumeWork(1, "output write");
    return write();
  };
  const result = (queues.get(scope) ?? Promise.resolve()).then(run, run);
  queues.set(
    scope,
    result.catch(() => {}),
  );
  return result;
}

/** A child retains the resolved sink object, independent of the parent's stack. */
export function bindOutputEndpoints(
  ctx: InterpreterContext,
  routes: PreparedRedirections["outputRoutes"],
  captureLive = false,
): OutputEndpoints {
  const bound: OutputEndpoints = Object.create(null);
  const endpoints = new Map<object, OutputEndpoint>();
  for (const stream of ["stdout", "stderr"] as const) {
    const sink = routes[stream];
    if (sink.kind === "endpoint") {
      bound[stream] = sink.endpoint;
      continue;
    }
    if (sink.kind === "live-stdout" || sink.kind === "live-stderr") {
      const target = sink.kind === "live-stdout" ? "stdout" : "stderr";
      const inherited = ctx.outputEndpoints?.[target];
      if (inherited && !inherited.stream) bound[stream] = inherited;
      else if (captureLive && ctx.output)
        bound[stream] = ctx.output.captureStream(inherited?.stream ?? target);
      else
        bound[stream] = inherited ?? {
          stream: target,
          write: async () => {},
        };
      continue;
    }
    let endpoint = endpoints.get(sink);
    if (!endpoint) {
      let position = 0;
      endpoint = {
        closed: sink.kind === "invalid-output",
        path:
          sink.kind === "file"
            ? sink.path
            : sink.kind === "descriptor" &&
                (sink.source.entry.kind === "output" ||
                  sink.source.entry.kind === "readwrite")
              ? sink.source.entry.path
              : undefined,
        write: (text, kind) =>
          serializeOutputWrite(ctx.executionScope, async () => {
            const encoding = kind === "bytes" ? "binary" : "utf8";
            if (sink.kind === "file") {
              if (sink.append)
                await writeOutputFile(
                  ctx.fs,
                  "appendFile",
                  sink.path,
                  text,
                  encoding,
                );
              else {
                if (
                  await tryAppendOutputFile(
                    ctx.fs,
                    sink.path,
                    position,
                    text,
                    encoding,
                  )
                ) {
                  position +=
                    kind === "bytes" ? text.length : utf8ByteLength(text);
                  return;
                }
                const bytes =
                  kind === "bytes"
                    ? text
                    : latin1FromBytes(encodeUtf8ToBytes(text));
                const size = (await ctx.fs.stat(sink.path)).size;
                if (size === position) {
                  await writeOutputFile(
                    ctx.fs,
                    "appendFile",
                    sink.path,
                    text,
                    encoding,
                  );
                  position += bytes.length;
                  return;
                }
                const lease = ctx.executionScope.reserveBytes(
                  size + Math.max(size, bytes.length + position),
                  "output endpoint",
                );
                try {
                  const previous = latin1FromBytes(
                    await readBytesFrom(ctx.fs, sink.path),
                  );
                  const padding =
                    position > previous.length
                      ? "\0".repeat(position - previous.length)
                      : "";
                  const next =
                    previous.slice(0, position) +
                    padding +
                    bytes +
                    previous.slice(position + bytes.length);
                  await writeOutputFile(
                    ctx.fs,
                    "writeFile",
                    sink.path,
                    next,
                    "binary",
                    {
                      writtenBytes: bytes.length,
                      previousSize: size,
                      retainedBytes:
                        size -
                        Math.min(bytes.length, Math.max(0, size - position)),
                    },
                  );
                  position += bytes.length;
                } finally {
                  lease.release();
                }
              }
            } else if (sink.kind === "descriptor") {
              const updated = await writeFdEntry(
                ctx,
                sink.source.entry,
                sink.source.descriptors,
                text,
                encoding,
              );
              if (updated) sink.source.entry = updated;
            }
            // Closed/discard endpoints consume no host output capability.
          }),
      };
      endpoints.set(sink, endpoint);
    }
    bound[stream] = endpoint;
  }
  return bound;
}

/** Resolve logical inherited streams before a command receives its writer. */
export function resolveEndpointRoute(
  ctx: InterpreterContext,
  sink: { kind: string },
): { kind: string } {
  const endpoint =
    sink.kind === "live-stdout"
      ? ctx.outputEndpoints?.stdout
      : sink.kind === "live-stderr"
        ? ctx.outputEndpoints?.stderr
        : undefined;
  return endpoint
    ? { kind: endpoint.stream ? `live-${endpoint.stream}` : "discard" }
    : sink;
}
