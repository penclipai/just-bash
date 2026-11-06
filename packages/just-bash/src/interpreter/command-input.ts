import { combineAbortSignals } from "../abort-signals.js";
import { BYTE_IO_BLOCK_BYTES, type ByteReader } from "../byte-io.js";
import {
  type ByteString,
  latin1FromBytes,
  unsafeBytesFromLatin1,
} from "../encoding.js";
import { ExecutionAbortedError } from "./errors.js";
import type { SharedInputSession } from "./types.js";

/** Legacy reads and byte reads consume one description, retaining unread tails. */
export function createCommandInput(
  initial: ByteString,
  liveInput: SharedInputSession | undefined,
  commandSignal: AbortSignal | undefined,
  consumed?: (remaining: string) => void,
): {
  reader: ByteReader;
  session: SharedInputSession;
  readonly consumed: number;
  readStdinChunk(signal?: AbortSignal): Promise<ByteString | null>;
  readStdin(signal?: AbortSignal): Promise<ByteString>;
  reconcileConsumed(bytes: number): void;
} {
  const source = liveInput?.readMore
    ? liveInput
    : { remaining: latin1FromBytes(initial) };
  const initialSize = source.remaining.length;
  let buffered: Promise<ByteString> | undefined;
  let taken = 0;
  let bufferedStart = 0;
  let bufferedBytes: string | undefined;
  let closed = false;
  const controller = new AbortController();
  let serial: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = serial.then(operation, operation);
    serial = result.catch(() => {});
    return result;
  };
  const take = async (maximum: number | undefined, signal?: AbortSignal) => {
    if (closed) return null;
    const combined = combineAbortSignals(
      commandSignal,
      controller.signal,
      signal,
    );
    try {
      if (combined.signal?.aborted)
        throw new ExecutionAbortedError("", "bash: stdin read aborted\n");
      while (!source.remaining && source.readMore) {
        const more = await source.readMore(combined.signal);
        if (combined.signal?.aborted)
          throw new ExecutionAbortedError("", "bash: stdin read aborted\n");
        if (!more) return null;
      }
      if (!source.remaining) return null;
      const size = Math.min(
        maximum ?? source.remaining.length,
        source.remaining.length,
      );
      const text = source.remaining.slice(0, size);
      source.remaining = source.remaining.slice(size);
      taken += size;
      consumed?.(source.remaining);
      return unsafeBytesFromLatin1(text);
    } finally {
      combined.cleanup();
    }
  };
  const close = async () => {
    closed = true;
    controller.abort();
    await serial;
  };
  const reader: ByteReader = {
    read(maxBytes = BYTE_IO_BLOCK_BYTES, signal) {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        maxBytes > BYTE_IO_BLOCK_BYTES
      )
        return Promise.reject(new RangeError("Invalid byte read size"));
      return enqueue(async () => {
        if (closed) return null;
        const chunk = await take(maxBytes, signal);
        if (chunk === null) return null;
        const text = latin1FromBytes(chunk);
        const bytes = new Uint8Array(text.length);
        for (let at = 0; at < text.length; at++)
          bytes[at] = text.charCodeAt(at);
        return bytes;
      });
    },
    close,
    cancel: close,
  };
  return {
    reader,
    session: source,
    get consumed() {
      return Math.max(taken, initialSize - source.remaining.length);
    },
    reconcileConsumed(bytes) {
      if (bufferedBytes === undefined || bytes >= taken) return;
      if (bytes < bufferedStart)
        throw new Error("Invalid buffered stdin consumption");
      source.remaining =
        bufferedBytes.slice(bytes - bufferedStart) + source.remaining;
      taken = bytes;
      bufferedBytes = undefined;
      consumed?.(source.remaining);
    },
    readStdinChunk: (signal?: AbortSignal) =>
      enqueue(() => take(undefined, signal)),
    readStdin(signal?: AbortSignal): Promise<ByteString> {
      if (closed) return Promise.resolve(unsafeBytesFromLatin1(""));
      buffered ??= enqueue(async () => {
        if (closed) return unsafeBytesFromLatin1("");
        const combined = combineAbortSignals(
          commandSignal,
          controller.signal,
          signal,
        );
        try {
          if (combined.signal?.aborted)
            throw new ExecutionAbortedError("", "bash: stdin read aborted\n");
          while (source.readMore && (await source.readMore(combined.signal))) {
            if (combined.signal?.aborted)
              throw new ExecutionAbortedError("", "bash: stdin read aborted\n");
          }
          if (combined.signal?.aborted)
            throw new ExecutionAbortedError("", "bash: stdin read aborted\n");
          const value = source.remaining;
          bufferedStart = taken;
          bufferedBytes = value;
          taken += value.length;
          source.remaining = "";
          consumed?.(source.remaining);
          return unsafeBytesFromLatin1(value);
        } finally {
          combined.cleanup();
        }
      }).catch((error) => {
        buffered = undefined;
        throw error;
      });
      return buffered;
    },
  };
}
