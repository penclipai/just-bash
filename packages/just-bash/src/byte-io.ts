/** A command borrows each byte block until its next read or close. */
export interface ByteReader {
  readonly size?: number;
  /** Read at most 64 KiB. null is permanent EOF; an empty block is not EOF. */
  read(maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Optional positional read, independent of the sequential cursor. */
  readAt?(
    offset: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}

/** The writer retains no reference to bytes after write resolves. */
export interface ByteWriter {
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface CommandByteIO {
  stdin: ByteReader;
  stdout: ByteWriter;
  stderr: ByteWriter;
}

export const BYTE_IO_BLOCK_BYTES: number = 64 * 1024;
