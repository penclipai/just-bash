import { nullPrototype } from "../query-engine/safe-object.js";
/**
 * GNU-style relative items for `date -d` (parse_datetime subset):
 * `[+-]N unit`, `N unit ago`, `next|last|this unit`, bare `unit`,
 * `tomorrow`/`yesterday`/`today`/`now`, and day-of-week names.
 * Calendar units move the wall clock in the display zone; hours, minutes
 * and seconds move the instant, matching GNU date.
 */

type UnitKind = "y" | "m" | "d" | "s";

const UNITS = nullPrototype<Record<string, [UnitKind, number]>>({
  year: ["y", 1],
  month: ["m", 1],
  fortnight: ["d", 14],
  week: ["d", 7],
  day: ["d", 1],
  hour: ["s", 3600],
  minute: ["s", 60],
  min: ["s", 60],
  second: ["s", 1],
  sec: ["s", 1],
});

const WEEKDAYS = nullPrototype<Record<string, number>>({
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednes: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
});

const ORDINALS = nullPrototype<Record<string, number>>({
  last: -1,
  this: 0,
  next: 1,
});

const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function unitOf(word: string | undefined): [UnitKind, number] | undefined {
  if (!word) return undefined;
  if (Object.hasOwn(UNITS, word)) return UNITS[word];
  if (word.endsWith("s") && Object.hasOwn(UNITS, word.slice(0, -1)))
    return UNITS[word.slice(0, -1)];
  return undefined;
}

function weekdayOf(word: string | undefined): number | undefined {
  return word && Object.hasOwn(WEEKDAYS, word) ? WEEKDAYS[word] : undefined;
}

export interface RelativeDateHooks {
  /** Parse the absolute part of the string (no relative items). */
  parseBase(s: string): Date | null;
  /** Date whose UTC fields are the wall clock shown in the display zone. */
  toWall(d: Date): Date | null;
  /** Inverse of toWall. */
  fromWall(wall: Date): Date | null;
  now(): Date;
}

/**
 * Returns undefined when the string has no relative items (caller keeps its
 * own parsing), null when it has them but is invalid, else the instant.
 */
export function parseRelativeDate(
  input: string,
  hooks: RelativeDateHooks,
): Date | null | undefined {
  const original = input.trim().split(/\s+/);
  const words = original.map((w) => w.toLowerCase());
  const rel: Record<UnitKind, number> = { y: 0, m: 0, d: 0, s: 0 };
  const items: Array<[UnitKind, number]> = [];
  let agoFrom = 0;
  let weekday: { day: number; ordinal: number } | undefined;
  let found = false;
  const base: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const num = /^([+-]?\d+)([a-z]+)?$/.exec(word);
    const numUnit = num && unitOf(num[2] ?? words[i + 1]);
    if (num && numUnit) {
      if (!num[2]) i++;
      items.push([numUnit[0], numUnit[1] * Number(num[1])]);
      found = true;
    } else if (Object.hasOwn(ORDINALS, word) && unitOf(words[i + 1])) {
      const [kind, size] = unitOf(words[++i]) as [UnitKind, number];
      items.push([kind, size * ORDINALS[word]]);
      found = true;
    } else if (
      Object.hasOwn(ORDINALS, word) &&
      weekdayOf(words[i + 1]) !== undefined
    ) {
      weekday = {
        day: weekdayOf(words[++i]) as number,
        ordinal: ORDINALS[word],
      };
      found = true;
    } else if (unitOf(word)) {
      const [kind, size] = unitOf(word) as [UnitKind, number];
      items.push([kind, size]);
      found = true;
    } else if (weekdayOf(word) !== undefined) {
      weekday = { day: weekdayOf(word) as number, ordinal: 0 };
      found = true;
    } else if (word === "ago" && items.length > agoFrom) {
      for (let j = agoFrom; j < items.length; j++) items[j][1] = -items[j][1];
      agoFrom = items.length;
    } else if (word === "tomorrow" || word === "yesterday") {
      items.push(["d", word === "tomorrow" ? 1 : -1]);
      found = true;
    } else if (word === "today" || word === "now") {
      found = true;
    } else {
      base.push(original[i]);
    }
  }
  if (!found) return undefined;
  for (const [kind, n] of items) rel[kind] += n;

  const baseStr = base.join(" ");
  const time = TIME_ONLY.exec(baseStr);
  let wall: Date | null;
  if (!baseStr || time) {
    wall = hooks.toWall(hooks.now());
    if (wall && time) {
      wall.setUTCHours(Number(time[1]), Number(time[2]), Number(time[3] ?? 0));
      wall.setUTCMilliseconds(0);
    }
  } else {
    const parsed = hooks.parseBase(baseStr);
    wall = parsed && hooks.toWall(parsed);
  }
  if (!wall || Number.isNaN(wall.getTime())) return null;

  // GNU ignores the day of week when an explicit date is given.
  if (weekday && (!baseStr || time)) {
    if (!time) wall.setUTCHours(0, 0, 0, 0);
    const current = wall.getUTCDay();
    const ahead = (weekday.day - current + 7) % 7;
    const shift =
      ahead +
      7 * (weekday.ordinal - (weekday.ordinal > 0 && ahead !== 0 ? 1 : 0));
    wall.setUTCDate(wall.getUTCDate() + shift);
  }

  const moved = new Date(
    Date.UTC(
      wall.getUTCFullYear() + rel.y,
      wall.getUTCMonth() + rel.m,
      wall.getUTCDate() + rel.d,
      wall.getUTCHours(),
      wall.getUTCMinutes(),
      wall.getUTCSeconds(),
      wall.getUTCMilliseconds(),
    ),
  );
  const instant = hooks.fromWall(moved);
  if (!instant || Number.isNaN(instant.getTime())) return null;
  const result = new Date(instant.getTime() + rel.s * 1000);
  return Number.isNaN(result.getTime()) ? null : result;
}
