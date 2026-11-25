/**
 * Automa: `new Date("Jan 5 2024")` reads a zoneless free-form date in the
 * host's zone. GNU date reads it in TZ (UTC under `-u`), so re-read the same
 * wall clock in the command's zone unless the text names a zone itself.
 */
const EXPLICIT_ZONE =
  /(?:\d|\b)(?:Z|UTC|GMT|UT|[ECMP][SD]T)\b|[+-]\d{2}:?\d{2}\s*$|\bGMT[+-]\d/i;

export function inCommandZone(
  text: string,
  hostParsed: Date,
  tz: string,
  parseWall: (wall: string, tz: string) => Date | null,
): Date | null {
  // ISO date-only forms are already read as UTC by the engine.
  if (EXPLICIT_ZONE.test(text) || /^\d{4}(?:-\d{2}){0,2}$/.test(text.trim()))
    return hostParsed;
  const pad = (n: number) => String(n).padStart(2, "0");
  const wall =
    `${String(hostParsed.getFullYear()).padStart(4, "0")}-` +
    `${pad(hostParsed.getMonth() + 1)}-${pad(hostParsed.getDate())} ` +
    `${pad(hostParsed.getHours())}:${pad(hostParsed.getMinutes())}:` +
    pad(hostParsed.getSeconds());
  const zoned = parseWall(wall, tz);
  if (!zoned) return null;
  return new Date(zoned.getTime() + hostParsed.getMilliseconds());
}
