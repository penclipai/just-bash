import { utf8ByteLength } from "../../encoding.js";
import type { CookieInput } from "../../network/fetch.js";
import type { RuntimeCommandContext } from "../../types.js";
import type { CurlOptions } from "./types.js";

/** Cookie files use the command's VFS. No browser or system jar is read here. */
export async function resolveCookieInput(
  options: CurlOptions,
  ctx: RuntimeCommandContext,
): Promise<CookieInput | undefined> {
  if (!options.cookieInputs.length) return;
  const literal: string[] = [];
  const jar: CookieInput["jar"] = [];
  for (const input of options.cookieInputs) {
    if (input === "" || input.includes("=")) {
      literal.push(input);
      continue;
    }
    const content = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, input));
    ctx.executionScope?.consumeInput(utf8ByteLength(content), "curl cookies");
    for (let line of content.split("\n")) {
      ctx.executionScope?.consumeWork(1, "curl cookies");
      ctx.signal?.throwIfAborted();
      line = line.replace(/\r$/, "");
      if (line.startsWith("#HttpOnly_")) line = line.slice(10);
      if (!line || line.startsWith("#")) continue;
      const [domain, subdomains, path, secure, expiration, name, value, extra] =
        line.split("\t");
      const expires = Number(expiration);
      if (
        extra !== undefined ||
        value === undefined ||
        !domain ||
        !path?.startsWith("/") ||
        !["TRUE", "FALSE"].includes(subdomains) ||
        !["TRUE", "FALSE"].includes(secure) ||
        !/^\d+$/.test(expiration) ||
        !Number.isFinite(expires) ||
        (options.junkSessionCookies && expires === 0)
      )
        continue;
      jar.push({
        domain,
        includeSubdomains: subdomains === "TRUE",
        path,
        secure: secure === "TRUE",
        expires,
        name,
        value,
      });
    }
  }
  return { literal: literal.filter(Boolean).join("; "), jar };
}
