import { afterEach, describe, expect, it, vi } from "vitest";
import { Bash } from "../../Bash.js";

async function show(expr: string, tz = "UTC"): Promise<string> {
  const env = new Bash({ env: { TZ: tz } });
  const r = await env.exec(`date -d '${expr}' '+%F %T %a'`);
  expect(r.stderr).toBe("");
  return r.stdout.trim();
}

describe("date -d relative items (GNU parity)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["2024-01-01 +1 day", "2024-01-02 00:00:00 Tue"],
    ["2024-01-01 -1 day", "2023-12-31 00:00:00 Sun"],
    ["2024-01-31 +1 month", "2024-03-02 00:00:00 Sat"],
    ["2024-01-01 3 days ago", "2023-12-29 00:00:00 Fri"],
    ["2024-01-01 1 week ago", "2023-12-25 00:00:00 Mon"],
    ["2024-01-01 next week", "2024-01-08 00:00:00 Mon"],
    ["2024-01-01 next day", "2024-01-02 00:00:00 Tue"],
    ["2024-01-01 day", "2024-01-02 00:00:00 Tue"],
    ["2024-01-01 +1day", "2024-01-02 00:00:00 Tue"],
    ["2024-01-01 +1 day 2 hours", "2024-01-02 02:00:00 Tue"],
    ["2024-01-01 +1 year", "2025-01-01 00:00:00 Wed"],
    ["2024-01-01 -1 fortnight", "2023-12-18 00:00:00 Mon"],
    ["2024-01-01 tomorrow", "2024-01-02 00:00:00 Tue"],
    ["2024-01-04 next monday", "2024-01-04 00:00:00 Thu"],
  ])("%s", async (expr, expected) => {
    expect(await show(expr)).toBe(expected);
  });

  it("keeps wall-clock days across DST in TZ", async () => {
    expect(await show("2024-03-10 +1 day", "America/New_York")).toBe(
      "2024-03-11 00:00:00 Mon",
    );
  });

  it("resolves weekdays and ago relative to now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T03:22:22Z")); // Thursday
    expect(await show("1 day ago")).toBe("2026-11-04 03:22:22 Wed");
    expect(await show("next monday")).toBe("2026-11-09 00:00:00 Mon");
    expect(await show("monday")).toBe("2026-11-09 00:00:00 Mon");
    expect(await show("thursday")).toBe("2026-11-05 00:00:00 Thu");
    expect(await show("next thursday")).toBe("2026-11-12 00:00:00 Thu");
    expect(await show("last thursday")).toBe("2026-10-29 00:00:00 Thu");
    expect(await show("last week")).toBe("2026-10-29 03:22:22 Thu");
    expect(await show("+3 days")).toBe("2026-11-08 03:22:22 Sun");
    expect(await show("next friday 10:00")).toBe("2026-11-06 10:00:00 Fri");
  });

  it("still rejects garbage", async () => {
    const env = new Bash({ env: { TZ: "UTC" } });
    const r = await env.exec("date -d 'blah +1 day'");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid date");
  });
});
