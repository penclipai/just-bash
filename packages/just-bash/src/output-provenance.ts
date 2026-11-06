import type { OutputSegment } from "./types.js";

interface Origin {
  readonly ordinal: number;
  publication?: number;
}
const origins = new WeakMap<OutputSegment, Origin>();
let next = 0;
let nextPublication = 0;
const supplements = new WeakMap<
  object,
  Map<
    "stdout" | "stderr",
    { text: string; prefix: boolean; segment: OutputSegment }
  >
>();

/** Generated wrapper diagnostics keep one origin across repeated views. */
export function outputSupplement(
  owner: object,
  stream: "stdout" | "stderr",
  text: string,
  prefix: boolean,
): OutputSegment {
  let entries = supplements.get(owner);
  if (!entries) {
    entries = new Map();
    supplements.set(owner, entries);
  }
  const previous = entries.get(stream);
  const part: OutputSegment = [stream, text, "text"];
  if (previous && previous.text === text && previous.prefix === prefix)
    return inheritOutputOrigin(previous.segment, part);
  outputOrigin(part);
  entries.set(stream, { text, prefix, segment: part });
  return part;
}

export function outputOrigin(segment: OutputSegment): Origin {
  let origin = origins.get(segment);
  if (!origin) {
    origin = { ordinal: next++ };
    origins.set(segment, origin);
  }
  return origin;
}

/** Called when a segment enters the shared publication queue. */
export function recordOutputPublication(segment: OutputSegment): void {
  const origin = outputOrigin(segment);
  origin.publication ??= nextPublication++;
}

export function inheritOutputOrigin(
  source: OutputSegment,
  target: OutputSegment,
): OutputSegment {
  origins.set(target, outputOrigin(source));
  return target;
}

/** Stable identities separate relayed output from an escaped descriptor write. */
export function mergeOutputOrigins(
  returned: readonly OutputSegment[],
  published: readonly OutputSegment[],
): OutputSegment[] {
  const seen = new Set<Origin>();
  const merged: OutputSegment[] = [];
  for (const group of [returned, published])
    for (const part of group) {
      const origin = outputOrigin(part);
      if (!seen.has(origin)) {
        seen.add(origin);
        merged.push(part);
      }
    }
  merged.sort((left, right) => {
    const a = outputOrigin(left),
      b = outputOrigin(right);
    if (a.publication !== undefined || b.publication !== undefined) {
      if (a.publication === undefined) return 1;
      if (b.publication === undefined) return -1;
      return a.publication - b.publication;
    }
    return a.ordinal - b.ordinal;
  });
  return merged;
}
