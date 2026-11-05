declare const __BROWSER__: boolean | undefined;

const BYTE_STRING_CHUNK_SIZE = 8192;

/** Latin1 here maps every byte directly, including 0x80–0x9f. */
export function stringFromBytes(bytes: Uint8Array): string {
  if (
    (typeof __BROWSER__ === "undefined" || !__BROWSER__) &&
    typeof Buffer !== "undefined"
  ) {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("latin1");
  }
  // Browser Buffer polyfills concatenate one character per byte. Reuse a
  // bounded argument array instead of building a large string rope.
  const chunks: string[] = [];
  const codes: number[] = [];
  for (let i = 0; i < bytes.length; i += BYTE_STRING_CHUNK_SIZE) {
    const length = Math.min(BYTE_STRING_CHUNK_SIZE, bytes.length - i);
    codes.length = length;
    for (let j = 0; j < length; j++) codes[j] = bytes[i + j];
    chunks.push(String.fromCharCode.apply(null, codes));
  }
  return chunks.join("");
}
