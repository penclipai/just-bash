import { decodeBytesToUtf8, unsafeBytesFromLatin1 } from "./encoding.js";
import type { OutputSegment } from "./types.js";

type Stream = "stdout" | "stderr";
const decode = (value: string) =>
  decodeBytesToUtf8(unsafeBytesFromLatin1(value));

/** One presentation decoder shared by live delivery and retained evidence. */
export function createOutputPresenter(
  publish: (text: string, stream?: Stream) => void | Promise<void>,
  aborted: () => boolean = () => false,
): {
  writeBytes(text: string, stream: Stream): Promise<void>;
  writeText(text: string, stream: Stream): Promise<void>;
  flush(): Promise<void>;
} {
  // Output is an ordered byte stream even when one UTF-8 character spans
  // command/descriptor boundaries. Retain at most three undecided bytes; do
  // not buffer completed output or decode each incomplete fragment separately.
  let pending = "";
  let pendingStream: Stream | undefined;
  const width = (lead: number) =>
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 0;
  const continuation = (lead: number, position: number, byte: number) =>
    byte >= 0x80 &&
    byte <= 0xbf &&
    (position !== 1 ||
      ((lead !== 0xe0 || byte >= 0xa0) &&
        (lead !== 0xed || byte <= 0x9f) &&
        (lead !== 0xf0 || byte >= 0x90) &&
        (lead !== 0xf4 || byte <= 0x8f)));
  async function flushPending() {
    const text = pending;
    const stream = pendingStream;
    pending = "";
    pendingStream = undefined;
    await publish(decode(text), stream);
  }
  async function write(text: string, stream: Stream) {
    if (pending) {
      const lead = pending.charCodeAt(0);
      let consumed = 0;
      while (
        consumed < text.length &&
        pending.length < width(lead) &&
        continuation(lead, pending.length, text.charCodeAt(consumed))
      )
        pending += text[consumed++];
      // An invalid continuation keeps the original decoder's byte fallback.
      // A complete character is attributed to its first byte's descriptor.
      if (pending.length === width(lead) || consumed < text.length)
        await flushPending();
      text = text.slice(consumed);
      if (!text || aborted()) return;
    }
    let end = text.length;
    for (let start = Math.max(0, end - 3); start < end; start++) {
      const lead = text.charCodeAt(start);
      const expected = width(lead);
      if (!expected || end - start >= expected) continue;
      let valid = true;
      for (let at = start + 1; at < end; at++)
        if (!continuation(lead, at - start, text.charCodeAt(at))) valid = false;
      if (!valid) continue;
      pending = text.slice(start);
      pendingStream = stream;
      end = start;
      break;
    }
    await publish(decode(text.slice(0, end)), stream);
  }
  return {
    writeBytes: write,
    async writeText(text, stream) {
      await flushPending();
      await publish(text, stream);
    },
    flush: flushPending,
  };
}

export async function presentOutputSegments(
  parts: readonly OutputSegment[],
): Promise<{ stdout: string; stderr: string }> {
  const result = { stdout: [] as string[], stderr: [] as string[] };
  const presenter = createOutputPresenter((text, stream = "stdout") => {
    result[stream].push(text);
  });
  for (const [stream, text, kind] of parts) {
    if (kind === "bytes") await presenter.writeBytes(text, stream);
    else await presenter.writeText(text, stream);
  }
  await presenter.flush();
  return { stdout: result.stdout.join(""), stderr: result.stderr.join("") };
}
