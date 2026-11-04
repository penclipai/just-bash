import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

describe("awk -v special variables", () => {
  it("applies OFS from -v (with escapes)", async () => {
    const env = new Bash();
    const r = await env.exec(
      `printf '1,a,x\\n2,b,y\\n' | awk -v OFS='\\t' -F, '{print $1,$3}'`,
    );
    expect(r.stdout).toBe("1\tx\n2\ty\n");
  });

  it("applies ORS, FS and SUBSEP from -v", async () => {
    const env = new Bash();
    const r = await env.exec(
      `printf 'a:b\\nc:d\\n' | awk -v ORS=';' -v FS=: -v SUBSEP=- '{k[$1,$2]=1; print $2} END{for (x in k) n++; print n}'`,
    );
    expect(r.stdout).toBe("b;d;2;");
  });

  it("keeps user -v variables as strnum", async () => {
    const env = new Bash();
    const r = await env.exec(`awk -v n=5 -v s=hi 'BEGIN{print n+1, s}'`);
    expect(r.stdout).toBe("6 hi\n");
  });
});
