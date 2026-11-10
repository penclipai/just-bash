/** Locate an ASCII literal directly in bytes without allocating a decoded string. */
export function containsAsciiBytes(bytes: Uint8Array, prefix: string): boolean {
  if (!prefix.length) return true;
  const first = prefix.charCodeAt(0);
  for (
    let i = bytes.indexOf(first);
    i !== -1;
    i = bytes.indexOf(first, i + 1)
  ) {
    let j = 1;
    while (j < prefix.length && bytes[i + j] === prefix.charCodeAt(j)) j++;
    if (j === prefix.length) return true;
  }
  return false;
}
