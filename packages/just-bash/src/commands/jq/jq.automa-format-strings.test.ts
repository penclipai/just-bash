import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";

const data = '{"items":[{"name":"a","n":1},{"name":"b,c","n":2}]}';

async function jq(filter: string): Promise<string> {
  const env = new Bash({ files: { "/d.json": data } });
  const r = await env.exec(`jq -r '${filter}' /d.json`);
  expect(r.stderr).toBe("");
  return r.stdout;
}

describe("jq format strings", () => {
  it("formats interpolations with @csv and @tsv", async () => {
    expect(await jq('.items[] | @csv "row: \\([.name, .n])"')).toBe(
      'row: "a",1\nrow: "b,c",2\n',
    );
    expect(await jq('.items[] | @tsv "\\([.name, .n])"')).toBe(
      "a\t1\nb,c\t2\n",
    );
  });

  it("formats strings and scalars with @base64, @uri, @sh, @json", async () => {
    expect(await jq('.items[0] | @base64 "x=\\(.name) n=\\(.n)"')).toBe(
      "x=YQ== n=MQ==\n",
    );
    expect(await jq('@uri "q=\\(.items[1].name)"')).toBe("q=b%2Cc\n");
    expect(await jq(`@sh "echo \\(.items[1].name)"`.replace(/'/g, ""))).toBe(
      "echo 'b,c'\n",
    );
    expect(await jq('@json "v=\\(.items[0])"')).toBe('v={"name":"a","n":1}\n');
  });

  it("keeps a plain format string literal unchanged", async () => {
    expect(await jq('@base64 "literal"')).toBe("literal\n");
  });
});

describe("jq @csv quoting", () => {
  it("quotes every string like jq (yq keeps minimal quoting)", async () => {
    const env = new Bash();
    const r = await env.exec(
      `jq -rn '[1,"a",null,true,"x\\"y"] | @csv'; echo '["a","b"]' | yq -o json '@csv'`,
    );
    expect(r.stdout).toBe('1,"a",,true,"x""y"\n"a,b"\n');
  });
});
