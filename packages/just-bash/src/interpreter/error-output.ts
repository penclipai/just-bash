import { utf8ByteLength } from "../encoding.js";
import { type OutputSource, outputSegments } from "../execution-output.js";
import type { ExecResult, OutputSegment } from "../types.js";
import type { ControlFlowError } from "./errors.js";

type ErrorOutputSource = OutputSource &
  Pick<ExecResult, "internalOutputAccounting">;
interface ErrorPart {
  segment: OutputSegment;
  relayed: boolean;
  accountedBytes: number;
}

const origins = new WeakMap<ControlFlowError, ErrorPart[]>();

function parts(
  source: ErrorOutputSource,
  relayed: boolean,
  fullyAccounted = false,
): ErrorPart[] {
  const credit = {
    stdout: source.internalOutputAccounting?.stdout ?? 0,
    stderr: source.internalOutputAccounting?.stderr ?? 0,
  };
  return outputSegments(source).map((segment) => {
    const [stream, text, kind] = segment;
    const bytes = kind === "bytes" ? text.length : utf8ByteLength(text);
    const accountedBytes = fullyAccounted
      ? bytes
      : Math.min(credit[stream], bytes);
    credit[stream] -= accountedBytes;
    return { segment, relayed, accountedBytes };
  });
}

function current(error: ControlFlowError): ErrorPart[] {
  let retained = origins.get(error);
  if (!retained) {
    retained = parts(error, false);
    origins.set(error, retained);
  }
  return retained;
}

function publish(error: ControlFlowError, retained: ErrorPart[]): void {
  error.stdout = "";
  error.stderr = "";
  error.internalOutputAccounting = { stdout: 0, stderr: 0 };
  error.internalOutputSegments = retained.map(({ segment, accountedBytes }) => {
    const [stream, text] = segment;
    error[stream] += text;
    error.internalOutputAccounting[stream] += accountedBytes;
    return segment;
  });
}

/** Accumulator prefixes have already passed through child output routing. */
export function prependRelayedErrorOutput(
  error: ControlFlowError,
  source: ErrorOutputSource,
): void {
  const retained = [...parts(source, true, true), ...current(error)];
  origins.set(error, retained);
  publish(error, retained);
}

/** Command-local prefixes still need their enclosing output route. */
export function prependFreshErrorOutput(
  error: ControlFlowError,
  stdout: string,
  stderr: string,
): void {
  const retained = [
    ...parts({ stdout, stderr }, false, true),
    ...current(error),
  ];
  origins.set(error, retained);
  publish(error, retained);
}

/** Preserve provenance when an already-routed result becomes an exception. */
export function seedRelayedErrorOutput(
  error: ControlFlowError,
  source: ErrorOutputSource,
): void {
  const retained = parts(source, true);
  origins.set(error, retained);
  publish(error, retained);
}

/** Process writers finish after the command's retained/error output. */
export function appendRelayedErrorOutput(
  error: ControlFlowError,
  source: ErrorOutputSource,
): void {
  const retained = [...current(error), ...parts(source, true)];
  origins.set(error, retained);
  publish(error, retained);
}

/** Wrapping a fatal error preserves both fresh and already-routed origins. */
export function inheritErrorOutput(
  target: ControlFlowError,
  source: ControlFlowError,
): void {
  const retained = [...current(source)];
  origins.set(target, retained);
  publish(target, retained);
}

/** Route only fresh diagnostics; prior child segments retain their positions. */
export async function resolveErrorOutput(
  error: ControlFlowError,
  routeFresh: (
    part: OutputSegment,
    alreadyAccountedBytes: number,
  ) => Promise<ExecResult>,
): Promise<void> {
  let retained = current(error);
  for (let index = 0; index < retained.length; ) {
    const part = retained[index];
    if (part.relayed) {
      index++;
      continue;
    }
    const routed = parts(
      await routeFresh(part.segment, part.accountedBytes),
      true,
    );
    retained = [
      ...retained.slice(0, index),
      ...routed,
      ...retained.slice(index + 1),
    ];
    origins.set(error, retained);
    publish(error, retained);
    index += routed.length;
  }
  publish(error, retained);
}
