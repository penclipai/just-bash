import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

/**
 * Automa text-command parity (bash-100 PR-A). Fixtures are recorded with GNU
 * awk 5.2 (as `awk`), GNU date/grep (coreutils 9.7, grep 3.11) and jq 1.7,
 * so they are locked. To re-record on a host with those tools:
 *
 *   mkdir -p /tmp/gnu-awk && ln -sf "$(command -v gawk)" /tmp/gnu-awk/awk
 *   PATH=/tmp/gnu-awk:$PATH RECORD_FIXTURES=force pnpm test:run \
 *     src/comparison-tests/automa-text-parity.comparison.test.ts
 */
const files = {
  "data.csv": "id,name,qty\n1,apple,10\n2,pear,5\n",
  "rs.txt": "a b;c d;e f",
  "data.json": '{"items":[{"name":"a","n":1},{"name":"b,c","n":2}]}',
  "src/a.js": "function a() {}\n",
  "src/sub/b.js": "function b() {}\n",
};

const cases: Record<string, string[]> = {
  "awk bare length": [
    "printf 'ab\\nabcdef\\n' | awk 'length > 3'",
    "printf 'ab\\nabcdef\\n' | awk '{print length, length $0}'",
    "printf 'a\\n\\nb\\n' | awk '!length {print NR}'",
  ],
  "awk -v special variables": [
    "awk -v OFS=- -F, '{print $1,$2}' data.csv",
    "awk -v FS=, -v OFS='\\t' '{$1=$1; print}' data.csv",
    "awk -v RS=';' '{print NR\": \"$0}' rs.txt",
    "awk -v ORS='|' -F, '{print $1}' data.csv",
  ],
  "date -d relative items": [
    "TZ=UTC date -d '2024-01-31 3 days ago' '+%F %T'",
    "TZ=UTC date -d '2024-02-28 + 2 days' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 - 1 day' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 next friday' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 yesterday' '+%F %T'",
    "TZ=UTC date -d 'Jan 5 2024 +1 day' '+%F %T'",
    "TZ=Asia/Tokyo date -d 'Jan 5 2024 10:00' '+%F %T %z'",
    "date -u -d '5 Jan 2024 2 weeks ago' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 12:00 +3 hours' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 12:00 + 3 hours' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 12:00:00 -2 days' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 12:00 +130 hours' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 12:00 3 hours' '+%F %T'",
    "TZ=UTC date -d '2024-01-01 12:00 UTC +3 hours' '+%F %T'",
    "TZ=UTC date -d '2024-12-31 23:59:59 +1 second' '+%F %T'",
  ],
  "grep -r operands": [
    "grep -rn function src/ | sort",
    "grep -r function src/sub/b.js",
    "grep -r function src/sub/b.js src/a.js",
    "grep -rc function src/sub",
  ],
  "jq format strings": [
    "jq -r '.items[] | @csv \"\\([.name, .n])\"' data.json",
    "jq -r '@base64 \"n=\\(.items[0].name)\"' data.json",
    "jq -r '@sh \"rm \\(.items | map(.name))\"' data.json",
    "jq -r '.items | map(.name, .n) | @sh' data.json",
    "jq -r '@sh \"x \\(1) \\(null)\"' data.json",
  ],
};

describe("Automa text parity - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  for (const [group, commands] of Object.entries(cases)) {
    describe(group, () => {
      for (const command of commands) {
        it(command, async () => {
          const env = await setupFiles(testDir, files);
          await compareOutputs(env, testDir, command);
        });
      }
    });
  }
});
