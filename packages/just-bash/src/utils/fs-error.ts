/**
 * strerror-style text for a filesystem error, so commands do not report
 * every failure (EFBIG, EACCES, EIO, ...) as "No such file or directory".
 * Errors without a recognized code keep the historical ENOENT text.
 */
const MESSAGES: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  EFBIG: "File too large",
  EIO: "Input/output error",
  ELOOP: "Too many levels of symbolic links",
  ENAMETOOLONG: "File name too long",
  ENOMEM: "Cannot allocate memory",
  EMFILE: "Too many open files",
  ESTALE: "Stale file handle",
};

export function fsErrorMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === "string" && code in MESSAGES) return MESSAGES[code];
  const message = error instanceof Error ? error.message : "";
  for (const [key, text] of Object.entries(MESSAGES))
    if (message.startsWith(`${key}:`) || message.startsWith(`${key} `))
      return text;
  return MESSAGES.ENOENT;
}
