import type {
  BufferEncoding,
  FileContent,
  IFileSystem,
  WriteFileOptions,
} from "./interface.js";

type WriteKind = "writeFile" | "appendFile";
type WriteOptions = WriteFileOptions | BufferEncoding;
export interface OutputWriteProvenance {
  readonly writtenBytes: number;
  readonly previousSize: number;
  readonly retainedBytes: number;
}

type OutputFileWriter = (
  kind: WriteKind,
  path: string,
  content: FileContent,
  options?: WriteOptions,
  provenance?: OutputWriteProvenance,
) => Promise<void>;
const writers = new WeakMap<IFileSystem, OutputFileWriter>();

/** A size mismatch returns false without any filesystem effect. */
export type OutputFileAppender = (
  path: string,
  expectedSize: number,
  content: FileContent,
  options?: WriteOptions,
) => Promise<boolean>;
const appenders = new WeakMap<IFileSystem, OutputFileAppender>();

/** Only trusted output routing can invoke this optional atomic capability. */
export function registerOutputFileAppender(
  fs: IFileSystem,
  appender: OutputFileAppender,
): void {
  appenders.set(fs, appender);
}

export function tryAppendOutputFile(
  fs: IFileSystem,
  path: string,
  expectedSize: number,
  content: FileContent,
  options?: WriteOptions,
): Promise<boolean> {
  return (
    appenders.get(fs)?.(path, expectedSize, content, options) ??
    Promise.resolve(false)
  );
}

/** Trusted routing authority is not a method on the command's FS capability. */
export function registerOutputFileWriter(
  fs: IFileSystem,
  writer: OutputFileWriter,
): void {
  writers.set(fs, writer);
}

export function writeOutputFile(
  fs: IFileSystem,
  kind: WriteKind,
  path: string,
  content: FileContent,
  options?: WriteOptions,
  provenance?: OutputWriteProvenance,
): Promise<void> {
  const writer = writers.get(fs);
  return writer
    ? writer(kind, path, content, options, provenance)
    : fs[kind](path, content, options);
}
