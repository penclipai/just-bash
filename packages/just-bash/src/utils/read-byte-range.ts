import type { ByteReader } from "../byte-io.js";

/** Complete a bounded positional window when a backend returns short reads. */
export async function readByteRange(
  readAt: NonNullable<ByteReader["readAt"]>,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const first = await readAt(offset, size, signal);
  if (first.length === size) return first;
  const bytes = new Uint8Array(size);
  bytes.set(first);
  let filled = first.length;
  while (filled < size) {
    signal?.throwIfAborted();
    const chunk = await readAt(offset + filled, size - filled, signal);
    if (!chunk.length)
      throw new Error("EIO: byte reader ended inside an admitted range");
    bytes.set(chunk, filled);
    filled += chunk.length;
  }
  return bytes;
}
