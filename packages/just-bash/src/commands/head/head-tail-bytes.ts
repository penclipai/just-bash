/** Select byte ranges before materializing a byte-shaped output string. */
export function selectHeadTailBytes(
  content: Uint8Array,
  command: "head" | "tail",
  lines: number,
  bytes: number | null,
  fromLine = false,
): Uint8Array {
  if (bytes !== null) {
    if (bytes === 0) return content.subarray(0, 0);
    return command === "head"
      ? content.subarray(0, bytes)
      : content.subarray(-bytes);
  }
  if (command === "head" || fromLine) {
    let position = 0;
    let remaining = command === "head" ? lines : Math.max(0, lines - 1);
    while (position < content.length && remaining > 0) {
      const newline = content.indexOf(10, position);
      if (newline === -1)
        return command === "head" ? content : content.subarray(0, 0);
      position = newline + 1;
      remaining--;
    }
    return command === "head"
      ? content.subarray(0, position)
      : content.subarray(position);
  }
  if (lines === 0 || content.length === 0) return content.subarray(0, 0);
  let position = content.length - 1;
  if (content[position] === 10) position--;
  let remaining = lines;
  while (position >= 0) {
    const newline = content.lastIndexOf(10, position);
    if (newline === -1) return content;
    if (--remaining === 0) return content.subarray(newline + 1);
    position = newline - 1;
  }
  return content;
}
