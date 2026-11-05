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
