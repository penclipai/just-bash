// Automa modifications: command-boundary streaming without replay or duplicate output.
import type { CommandNode } from "./ast/types.js";
import {
  decodeBytesToUtf8,
  decodedTextFromResult as normalize,
  unsafeBytesFromLatin1,
} from "./encoding.js";
import { outputSize, outputSegments as segments } from "./execution-output.js";
import type { ExecutionScope } from "./execution-scope.js";
import type { InterpreterContext } from "./interpreter/types.js";
import {
  createOutputPresenter,
  presentOutputSegments,
} from "./output-presentation.js";
import {
  inheritOutputOrigin,
  mergeOutputOrigins,
  outputOrigin,
  outputSupplement,
  recordOutputPublication,
} from "./output-provenance.js";
import { markPresentedOutput } from "./presented-output.js";
import type { ExecResult, OutputSegment } from "./types.js";

export interface OutputSink {
  /** Capture the destination now, independently of later command frames. */
  captureStream(stream: Stream): {
    readonly closed: boolean;
    write(
      text: string,
      kind: "text" | "bytes",
      origin?: OutputSegment,
    ): Promise<void>;
  };
  setCommandRoutes(routes: Record<Stream, { kind: string }>): void;
  commandWriter():
    | ((
        text: string,
        stream: Stream,
        kind?: "text" | "bytes",
        origin?: OutputSegment,
      ) => Promise<void>)
    | undefined;
  capture(
    ctx: InterpreterContext,
    command: CommandNode,
    execute: () => Promise<ExecResult>,
  ): Promise<ExecResult>;
  route(
    result: ExecResult,
    stdout: { kind: string },
    stderr: { kind: string },
  ): void;
  pipeline(
    intermediate: boolean,
    pipeStderr: boolean,
    execute: () => Promise<ExecResult>,
    depth?: number,
  ): Promise<ExecResult>;
  buffer<T>(execute: () => Promise<T>): Promise<T>;
  finish<T extends ExecResult>(result: T): Promise<T & { output: string }>;
  fork(background?: boolean): OutputSink;
  release(): void;
  captureResult(depth?: number): {
    finish(result: ExecResult): ExecResult;
    close(): void;
  };
}
interface WriterPins {
  count: number;
  waiters: (() => void)[];
}
interface ResultCapture {
  depth: number;
  leases: import("./execution-scope.js").ResourceLease[];
  pipeline?: WriterPins;
  parts: OutputSegment[];
  seen: WeakSet<Part>;
  background: boolean;
  closed: boolean;
}

type Stream = "stdout" | "stderr";
interface OutputFrame {
  parts: Part[];
  depth: number;
  hidden: Record<Stream, boolean>;
  routes?: Record<Stream, { kind: string }>;
}
interface Part {
  text: string;
  stream: Stream;
  kind?: "text" | "bytes";
  emitted?: boolean;
  origin?: OutputSegment;
}
const decode = (value: string) =>
  decodeBytesToUtf8(unsafeBytesFromLatin1(value));
export function createOutputSink(
  scope: ExecutionScope,
  callback?: (text: string, stream: Stream) => void | Promise<void>,
  rawCallback?: (
    text: string,
    stream: Stream,
    kind: "text" | "bytes",
  ) => void | Promise<void>,
): OutputSink {
  const counts = { stdout: 0, stderr: 0 };
  const aborted = () => scope.signal?.aborted || scope.shellJobs.signal.aborted;
  const chunks: string[] = [];
  const published = { stdout: [] as string[], stderr: [] as string[] };
  let capturedWrites = false;
  let trackPublished = false;
  let finishing = false;
  const publishedParts: OutputSegment[] = [];
  const publicationLeases: import("./execution-scope.js").ResourceLease[] = [];
  let publication: Promise<void> = Promise.resolve();
  const writers: WriterPins = { count: 0, waiters: [] };
  const waitWriters = (pins: WriterPins) =>
    pins.count
      ? new Promise<void>((resolve) => pins.waiters.push(resolve))
      : Promise.resolve();
  const releaseWriter = (pins: WriterPins) => {
    pins.count--;
    if (!pins.count) for (const resolve of pins.waiters.splice(0)) resolve();
  };
  async function publish(text: string, stream: Stream = "stdout") {
    if (!text || aborted()) return;
    chunks.push(text);
    published[stream].push(text);
    if (callback) await callback(text, stream);
  }
  const presentation = createOutputPresenter(publish, aborted);
  const flushPending = presentation.flush;
  const write = presentation.writeBytes;
  function branch(
    initialMask = { stdout: false, stderr: false },
    initialFrame?: OutputFrame,
    inheritedCaptures: ResultCapture[] = [],
    initialPipeline?: WriterPins,
    ownsWriter = false,
  ): OutputSink {
    let mask = { ...initialMask };
    let current: OutputFrame | undefined = initialFrame;
    let captures = [...inheritedCaptures];
    let pipelineTarget = initialPipeline;
    let released = false;
    let bufferedBatches = 0;
    function complete(parts: Part[], result: ExecResult) {
      if (!parts.length)
        for (const origin of segments(result)) {
          const [stream, text, kind] = origin;
          parts.push({ text, stream, kind, emitted: false, origin });
        }
      const joined = { stdout: "", stderr: "" };
      for (const part of parts) joined[part.stream] += part.text;
      for (const stream of ["stdout", "stderr"] as const) {
        const value = stream === "stdout" ? normalize(result) : result.stderr;
        let previous = joined[stream];
        // Upstream accumulators can retain raw bytes or a decoded child string.
        // Compare their exact representation before appending wrapper diagnostics;
        // never infer the encoding of a new output segment from its characters.
        if (
          previous &&
          !value.startsWith(previous) &&
          !value.endsWith(previous)
        ) {
          let shown = "";
          let bytes = "";
          for (const part of parts) {
            if (part.stream !== stream) continue;
            if (part.kind === "bytes") bytes += part.text;
            else {
              shown += decode(bytes) + part.text;
              bytes = "";
            }
          }
          shown += decode(bytes);
          if (shown && (value.startsWith(shown) || value.endsWith(shown)))
            previous = shown;
        }
        if (value.length <= previous.length) continue;
        const prefix = previous && value.endsWith(previous);
        const text = prefix
          ? value.slice(0, -previous.length)
          : value.slice(previous.length);
        const part: Part = {
          text,
          stream,
          kind: "text",
          emitted: false,
          origin: outputSupplement(result, stream, text, Boolean(prefix)),
        };
        if (prefix) parts.unshift(part);
        else parts.push(part);
      }
      return parts;
    }
    async function emit(
      part: Part,
      hidden = mask,
      stream = part.stream,
      depth = current?.depth ?? 0,
      destinations = captures,
      targetPipeline = pipelineTarget,
    ) {
      const { text } = part;
      if (!text || part.emitted || aborted()) return;
      for (const capture of destinations) {
        const belongs = capture.pipeline
          ? capture.pipeline === targetPipeline
          : !targetPipeline || stream === "stderr";
        if (
          belongs &&
          (stream !== "stdout" || depth <= capture.depth) &&
          !capture.closed &&
          !capture.seen.has(part)
        ) {
          capture.leases.push(
            scope.reserveBytes(64, "output capture metadata"),
          );
          capture.seen.add(part);
          capture.parts.push([stream, text, part.kind ?? "text"]);
        }
      }
      if (hidden[stream]) return;
      if (part.origin) recordOutputPublication(part.origin);
      if (trackPublished && !finishing) {
        scope.consumeWork(1, "published output segment");
        publicationLeases.push(
          scope.reserveBytes(96, "published output metadata"),
        );
        const retained: OutputSegment = [stream, text, part.kind ?? "text"];
        if (part.origin) inheritOutputOrigin(part.origin, retained);
        else outputOrigin(retained);
        recordOutputPublication(retained);
        publishedParts.push(retained);
      }
      part.emitted = true;
      counts[stream] += text.length;
      const operation = publication.then(async () => {
        if (aborted()) return;
        if (rawCallback) await rawCallback(text, stream, part.kind ?? "text");
        if (part.kind === "bytes") await write(text, stream);
        else {
          await flushPending();
          await publish(text, stream);
        }
      });
      publication = operation.catch(() => {});
      await operation;
    }
    function captureResult(
      pipeline?: WriterPins,
      depth = current?.depth ?? 0,
    ): {
      finish(result: ExecResult): ExecResult;
      close(): void;
    } {
      const capture: ResultCapture = {
        depth,
        leases: [],
        pipeline,
        parts: [],
        seen: new WeakSet(),
        background: false,
        closed: false,
      };
      captures.push(capture);
      scope.registerCleanup(() => {
        for (const lease of capture.leases) lease.release();
      });
      const close = () => {
        capture.closed = true;
        captures = captures.filter((entry) => entry !== capture);
      };
      return {
        close,
        finish(result: ExecResult) {
          close();
          if (!capture.background) return result;
          const stdout = capture.parts
            .filter(([stream]) => stream === "stdout")
            .map(([, text]) => text)
            .join("");
          const stderr = capture.parts
            .filter(([stream]) => stream === "stderr")
            .map(([, text]) => text)
            .join("");
          const captured = {
            ...result,
            stdout,
            stderr,
            internalOutputSegments: capture.parts,
          };
          return {
            ...captured,
            internalOutputAccounting: {
              stdout: outputSize(captured, "stdout"),
              stderr: outputSize(captured, "stderr"),
            },
          };
        },
      };
    }
    return {
      captureStream(stream) {
        if (!trackPublished) {
          trackPublished = true;
          scope.registerCleanup(() => {
            for (const lease of publicationLeases) lease.release();
          });
        }
        const hidden = { ...(current?.hidden ?? mask) };
        const depth = current?.depth ?? 0;
        const destinations = [...captures];
        const targetPipeline = pipelineTarget;
        const collectors = destinations.filter((capture) =>
          capture.pipeline
            ? capture.pipeline === targetPipeline
            : !targetPipeline || stream === "stderr",
        );
        return {
          get closed() {
            return (
              released ||
              (hidden[stream] &&
                collectors.length > 0 &&
                collectors.every((capture) => capture.closed))
            );
          },
          async write(text, kind, origin) {
            if (this.closed) throw new Error("Output destination is closed");
            capturedWrites = true;
            for (const capture of collectors)
              if (!capture.closed) capture.background = true;
            await emit(
              { text, stream, kind, origin },
              hidden,
              stream,
              depth,
              destinations,
              targetPipeline,
            );
          },
        };
      },
      fork(background = false) {
        if (background)
          for (const capture of captures) capture.background = true;
        writers.count++;
        if (pipelineTarget) pipelineTarget.count++;
        return branch(mask, current, captures, pipelineTarget, true);
      },
      release() {
        if (released) return;
        released = true;
        if (ownsWriter) {
          releaseWriter(writers);
          if (initialPipeline) releaseWriter(initialPipeline);
        }
        current = undefined;
        captures = [];
      },
      captureResult: (depth) => captureResult(undefined, depth),
      setCommandRoutes(routes: Record<Stream, { kind: string }>): void {
        if (current && !bufferedBatches) current.routes = routes;
      },
      /** Keep the original descriptor for final routing, publish only to a known live destination. */
      commandWriter():
        | ((
            text: string,
            stream: Stream,
            kind?: "text" | "bytes",
            origin?: OutputSegment,
          ) => Promise<void>)
        | undefined {
        if (!current?.routes || bufferedBatches) return undefined;
        const frame = current;
        const routes = current.routes;
        return async (text, stream, kind = "text", origin) => {
          const part: Part = { text, stream, kind, origin };
          frame.parts.push(part);
          const target = routes[stream].kind;
          if (target === "live-stdout")
            await emit(part, frame.hidden, "stdout", frame.depth);
          if (target === "live-stderr")
            await emit(part, frame.hidden, "stderr", frame.depth);
        };
      },
      async capture(
        ctx: InterpreterContext,
        command: CommandNode,
        execute: () => Promise<ExecResult>,
      ): Promise<ExecResult> {
        if (bufferedBatches) return execute();
        const previous = mask;
        const parent = current;
        const depth = ctx.substitutionDepth ?? 0;
        const frame: OutputFrame = {
          parts: [],
          depth,
          hidden: depth > 0 ? { stdout: true, stderr: true } : previous,
        };
        current = frame;
        // Compound redirects are resolved after the buffered body. Hold its
        // descendants until that exact upstream route has been applied.
        if (command.redirections?.length || frame.depth > 0)
          mask = { stdout: true, stderr: true };
        const propagate = () => {
          if (!parent) return;
          for (const part of frame.parts) {
            if (frame.depth > parent.depth && part.stream === "stdout")
              continue;
            parent.parts.push(part);
          }
        };
        try {
          let result = await execute();
          result = scope.accountResult(result, "pipeline");
          complete(frame.parts, result);
          mask = frame.depth > 0 ? { stdout: true, stderr: true } : previous;
          for (const part of frame.parts) await emit(part);
          propagate();
          return result;
        } catch (error) {
          propagate();
          throw error;
        } finally {
          mask = previous;
          current = parent;
        }
      },
      route(
        result: ExecResult,
        stdout: { kind: string },
        stderr: { kind: string },
      ): void {
        if (!current || bufferedBatches) return;
        const routed: Part[] = [];
        for (const part of complete(current.parts, result)) {
          const target = part.stream === "stdout" ? stdout : stderr;
          if (target.kind !== "live-stdout" && target.kind !== "live-stderr")
            continue;
          const stream = target.kind === "live-stdout" ? "stdout" : "stderr";
          routed.push(stream === part.stream ? part : { ...part, stream });
        }
        current.parts = routed;
      },
      async pipeline(
        intermediate: boolean,
        pipeStderr: boolean,
        execute: () => Promise<ExecResult>,
        depth = current?.depth ?? 0,
      ): Promise<ExecResult> {
        if (bufferedBatches) return execute();
        const previous = mask;
        const previousPipeline = pipelineTarget;
        const parent = current;
        const start = parent?.parts.length ?? 0;
        let capture: ReturnType<typeof captureResult> | undefined;
        if (intermediate) {
          mask = { stdout: true, stderr: previous.stderr || pipeStderr };
          pipelineTarget = { count: 0, waiters: [] };
          capture = captureResult(pipelineTarget, depth);
        }
        try {
          const result = await execute();
          if (pipelineTarget && intermediate) await waitWriters(pipelineTarget);
          return capture?.finish(result) ?? result;
        } finally {
          capture?.close();
          pipelineTarget = previousPipeline;
          mask = previous;
          if (intermediate && parent) {
            const consumed = parent.parts.splice(start);
            if (!pipeStderr)
              for (const part of consumed)
                if (part.stream === "stderr") parent.parts.push(part);
          }
        }
      },
      async buffer<T>(execute: () => Promise<T>): Promise<T> {
        bufferedBatches++;
        try {
          return await execute();
        } finally {
          bufferedBatches--;
        }
      },
      async finish<T extends ExecResult>(
        result: T,
      ): Promise<T & { output: string }> {
        await waitWriters(writers);
        finishing = true;
        // A fatal command may have buffered partial stdout that never reached fd1
        // (for example an exhausted awk before a pipe). Keep it in stdout as
        // failure evidence; do not publish it as terminal output.
        if (!result.executionFailure)
          await emit({
            text: normalize(result).slice(counts.stdout),
            stream: "stdout",
          });
        await emit({
          text: result.stderr.slice(counts.stderr),
          stream: "stderr",
        });
        await publication;
        await flushPending();
        if (capturedWrites && result.executionFailure) {
          const presented = await presentOutputSegments(
            mergeOutputOrigins(segments(result), publishedParts),
          );
          return markPresentedOutput({
            ...result,
            ...presented,
            stdoutKind: "text" as const,
            stdoutEncoding: undefined,
            internalOutputSegments: undefined,
            output: chunks.join(""),
          });
        }
        const usePublished =
          (scope.shellJobs.used || capturedWrites) && !result.executionFailure;
        const finalResult = {
          ...result,
          ...(usePublished
            ? {
                stdout: published.stdout.join(""),
                stderr: published.stderr.join(""),
                stdoutKind: "text" as const,
                stdoutEncoding: undefined,
                internalOutputSegments: undefined,
              }
            : Object.create(null)),
          output: chunks.join(""),
        };
        return usePublished ? markPresentedOutput(finalResult) : finalResult;
      },
    };
  }
  return branch();
}
