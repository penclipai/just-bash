import type { ByteReader } from "../byte-io.js";

/** Validate close before returning a result; cleanup cannot hide read failure. */
export async function withByteReader<T>(
  reader: ByteReader,
  read: (reader: ByteReader) => Promise<T>,
): Promise<T> {
  let value: T;
  try {
    value = await read(reader);
  } catch (error) {
    try {
      await reader.close();
    } catch {
      // The original read or resource failure remains authoritative.
    }
    throw error;
  }
  await reader.close();
  return value;
}
