/** DNS rebinding and private-IP enforcement tests. */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSecureFetch } from "../fetch.js";
import { NetworkAccessDeniedError } from "../types.js";
import {
  createBashEnvAdapter,
  createMockFetch,
  MOCK_SUCCESS_BODY,
  originalFetch,
} from "./shared.js";

const lookup = vi.hoisted(() => {
  vi.resetModules();
  return vi.fn(async (_hostname: string) => [
    { address: "93.184.216.34", family: 4 },
  ]);
});
vi.mock("node:dns/promises", () => {
  const mocked = (hostname: string) => lookup(hostname);
  return { lookup: mocked, default: { lookup: mocked } };
});

describe("DNS rebinding SSRF protection", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeAll(() => {
    mockFetch = createMockFetch();
    global.fetch = mockFetch as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("blocks private IP literals (lexical pre-check)", () => {
    // These are caught before any DNS resolution, matching the bespoke
    // implementation's lexical check that runs before DNS.
    const cases: Array<[string, string]> = [
      ["https://127.0.0.1/data", "127.0.0.1"],
      ["https://10.0.0.1/data", "10.0.0.1"],
      ["https://192.168.1.1/data", "192.168.1.1"],
      ["https://172.16.0.1/data", "172.16.0.1"],
      ["https://[::1]/data", "[::1]"],
      ["https://localhost/data", "localhost"],
      ["https://169.254.169.254/latest/meta-data", "169.254.169.254"],
    ];

    it.each(cases)("blocks %s without reaching fetch", async (url) => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: true,
      });
      const callsBefore = mockFetch.mock.calls.length;
      await expect(secureFetch(url)).rejects.toThrow(NetworkAccessDeniedError);
      await expect(secureFetch(url)).rejects.toThrow(
        "private/loopback IP address blocked",
      );
      expect(mockFetch.mock.calls).toHaveLength(callsBefore);
    });
  });

  describe("denyPrivateRanges=false skips all checks", () => {
    it("allows private IP literals when denyPrivateRanges is off", async () => {
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: false,
      });
      // With denyPrivateRanges=false, even private IPs pass through to the
      // mock fetch (no lexical or DNS check runs).
      const result = await secureFetch("https://127.0.0.1/data");
      expect(result.status).toBe(404); // mock returns 404 for unknown URLs
    });

    it("allows allow-listed URLs without DNS when denyPrivateRanges is off", async () => {
      const env = createBashEnvAdapter({
        network: {
          allowedUrlPrefixes: ["https://api.example.com"],
          denyPrivateRanges: false,
        },
      });
      const result = await env.exec('curl "https://api.example.com/data"');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(MOCK_SUCCESS_BODY);
    });
  });

  describe("guarded-fetch error mapping", () => {
    it("maps host_not_allowed to NetworkAccessDeniedError", async () => {
      const secureFetch = createSecureFetch({
        allowedUrlPrefixes: ["https://api.example.com"],
      });
      // api.example.com is allowed but evil.com is not in the allow-list.
      // guarded-fetch rejects by host_not_allowed; the adapter maps it.
      await expect(secureFetch("https://evil.com/data")).rejects.toThrow(
        NetworkAccessDeniedError,
      );
    });

    it("rejects a redirect to a private IP literal", async () => {
      // Resolve the first hop to a public address, then reject the private
      // redirect without sending a second request. Both seams stay local.
      const transport = vi.fn(
        async () =>
          new Response("", {
            status: 302,
            headers: { location: "https://127.0.0.1/data" },
          }),
      );
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: true,
        _fetch: transport,
      });

      await expect(secureFetch("https://evil.com/start")).rejects.toThrow(
        "Redirect target not in allow-list",
      );
      expect(lookup).toHaveBeenCalledWith("evil.com");
      expect(transport).toHaveBeenCalledTimes(1);
    });
  });

  describe("lexical check runs before any transport", () => {
    it("blocks IP literals without reaching fetch", async () => {
      const callsBefore = mockFetch.mock.calls.length;
      const secureFetch = createSecureFetch({
        dangerouslyAllowFullInternetAccess: true,
        denyPrivateRanges: true,
      });
      await expect(secureFetch("https://127.0.0.1/data")).rejects.toThrow(
        "private/loopback IP address blocked",
      );
      expect(mockFetch.mock.calls).toHaveLength(callsBefore);
    });
  });
});
