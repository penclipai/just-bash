import { BYTE_IO_BLOCK_BYTES, type ByteReader } from "../byte-io.js";

/** Bounded views for legacy filesystems, without a byte-string conversion. */
export function bufferByteReader(
  bytes: Uint8Array,
): ByteReader & Required<Pick<ByteReader, "readAt">> {
  let offset = 0;
  let closed = false;
  const readAt = async (
    position: number,
    maxBytes: number,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    if (closed) throw new Error("Byte reader is closed");
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > BYTE_IO_BLOCK_BYTES
    )
      throw new RangeError("Invalid byte read range");
    return bytes.subarray(
      position,
      Math.min(bytes.length, position + maxBytes),
    );
  };
  return {
    size: bytes.byteLength,
    readAt,
    async read(maxBytes = BYTE_IO_BLOCK_BYTES, signal) {
      if (closed || offset === bytes.byteLength) return null;
      const chunk = await readAt(offset, maxBytes, signal);
      offset += chunk.length;
      return chunk;
    },
    async close() {
      closed = true;
    },
    async cancel() {
      closed = true;
    },
  };
}
