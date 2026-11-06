import type { ByteReader, ByteWriter, CommandByteIO } from "../byte-io.js";

type Guard = <A extends unknown[], R>(
  fn: (...args: A) => R,
  phase: string,
) => (...args: A) => R;

/** Preserve nested reader/writer capability checks after opening a reader. */
export function guardByteReader(reader: ByteReader, guard: Guard): ByteReader {
  return {
    size: reader.size,
    read: guard(reader.read.bind(reader), "byte read"),
    ...(reader.readAt
      ? { readAt: guard(reader.readAt.bind(reader), "byte positional read") }
      : Object.create(null)),
    close: guard(reader.close.bind(reader), "byte reader close"),
    cancel: guard(reader.cancel.bind(reader), "byte reader cancel"),
  };
}

export function guardCommandByteIO(
  io: CommandByteIO,
  guard: Guard,
): CommandByteIO {
  const writer = (target: ByteWriter): ByteWriter => ({
    write: guard(target.write.bind(target), "byte write"),
    close: guard(target.close.bind(target), "byte writer close"),
    abort: guard(target.abort.bind(target), "byte writer abort"),
  });
  return {
    stdin: guardByteReader(io.stdin, guard),
    stdout: writer(io.stdout),
    stderr: writer(io.stderr),
  };
}
