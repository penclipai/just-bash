/** End-to-end curl admission with mocked DNS and HTTP transports. */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createBashEnvAdapter,
  createMockFetch,
  MOCK_SUCCESS_BODY,
  originalFetch,
} from "./shared.js";

const lookup = vi.hoisted(() => {
  vi.resetModules();
  return vi.fn<
    (hostname: string) => Promise<{ address: string; family: number }[]>
  >();
});
vi.mock("node:dns/promises", () => {
  const mocked = (hostname: string) => lookup(hostname);
  return { lookup: mocked, default: { lookup: mocked } };
});

describe("DNS admission through curl", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeAll(() => {
    lookup.mockImplementation(async (hostname) => {
      if (hostname === "missing.example")
        throw Object.assign(new Error("DNS record not found"), {
          code: "ENOTFOUND",
        });
      return [{ address: "93.184.216.34", family: 4 }];
    });
    mockFetch = createMockFetch();
    global.fetch = mockFetch as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves an allowed host before the mocked transport", async () => {
    const env = createBashEnvAdapter({
      network: {
        allowedUrlPrefixes: ["https://api.example.com"],
        denyPrivateRanges: true,
      },
    });

    const result = await env.exec('curl "https://api.example.com/data"');
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: MOCK_SUCCESS_BODY,
      stderr: "",
    });
    expect(lookup).toHaveBeenCalledWith("api.example.com");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects failed DNS without calling the transport", async () => {
    const env = createBashEnvAdapter({
      network: {
        allowedUrlPrefixes: ["https://missing.example"],
        denyPrivateRanges: true,
      },
    });

    const callsBefore = mockFetch.mock.calls.length;
    const result = await env.exec('curl "https://missing.example/data"');
    expect(result).toMatchObject({
      exitCode: 7,
      stdout: "",
      stderr:
        "curl: (7) Network access denied: DNS resolution failed for private IP check: https://missing.example/data\n",
    });
    expect(lookup).toHaveBeenCalledWith("missing.example");
    expect(mockFetch.mock.calls).toHaveLength(callsBefore);
  });
});
