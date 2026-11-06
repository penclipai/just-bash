interface Cursor {
  raw: string;
}
const cursors = new WeakMap<Set<number>, Cursor>();

export function shareDescription(group: Set<number>, raw: string): void {
  if (!cursors.has(group)) cursors.set(group, { raw });
}
export function inheritDescription(
  source: Set<number>,
  target: Set<number>,
): void {
  const cursor = cursors.get(source);
  if (cursor) cursors.set(target, cursor);
}
export function descriptionRaw(
  group: Set<number> | undefined,
): string | undefined {
  return group && cursors.get(group)?.raw;
}
export function updateDescriptionRaw(
  group: Set<number> | undefined,
  raw: string,
): void {
  const cursor = group && cursors.get(group);
  if (cursor) cursor.raw = raw;
}
