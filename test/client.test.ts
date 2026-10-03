import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGateClient,
  GATE_TIMEOUT_MS,
  MAX_SCAN_BODY_BYTES,
} from "../src/gate-client.js";
import { fetchExternalText } from "../src/processor.js";
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
afterEach(() => vi.useRealTimers());

describe("credentialed client contract", () => {
  it("uses exact original URL and disables redirects without retries", async () => {
    const original = "https://example.test/a,b?next=x,y&k=a%2Fb#fragment";
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json(fixture("url-allow")),
    );
    const response = await createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    }).checkUrl(original);
    expect(response.verdict).toBe("allow");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      `https://api.ismalicious.com/gate/url?u=${encodeURIComponent(original)}`,
    );
    expect(new URL(url as string).searchParams.get("u")).toBe(original);
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      "X-API-KEY": Buffer.from("fixture-key:fixture-secret").toString("base64"),
    });
  });

  it("preserves inner unknown, truncation and extra fields on a valid allow", async () => {
    const payload = {
      ...(fixture("scan-allow-unknown-link") as object),
      links_truncated: true,
      future_field: "preserved",
    };
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl: async () => Response.json(payload),
    });
    const response = await gate.scan({ text: "synthetic text" });
    expect(response).toEqual(payload);
    expect(response.links[0]?.verdict).toBe("unknown");
  });

  it("aborts an outstanding request after the actual configured 15 seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init!.signal as AbortSignal;
          signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    });
    const rejection = expect(gate.scan({ text: "text" })).rejects.toMatchObject(
      { code: "transport" },
    );
    await vi.advanceTimersByTimeAsync(GATE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 302, 500])(
    "fails on HTTP %s and does not retry",
    async (status) => {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response("remote body never included", { status }),
      );
      const gate = createGateClient({
        apiKey: "fixture-key",
        apiSecret: "fixture-secret",
        fetchImpl,
      });
      await expect(gate.scan({ text: "text" })).rejects.toMatchObject({
        code: "http",
        message: "IsMalicious gate refused (http)",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects oversized UTF-8 JSON without truncating or sending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    });
    await expect(
      gate.scan({ text: "é".repeat(MAX_SCAN_BODY_BYTES / 2) }),
    ).rejects.toMatchObject({ code: "input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks a permitted URL before fetch and returns the exact original content", async () => {
    const url = "https://example.test/a,b?q=x,y#f";
    const events: string[] = [];
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl: async () => {
        events.push("gate");
        return Response.json(fixture("url-allow"));
      },
    });
    const text = "synthetic original bytes";
    const destinationFetch = vi.fn<typeof fetch>(async () => {
      events.push("fetch");
      return new Response(text, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });
    expect(
      await fetchExternalText({
        url,
        allowedUrls: [url],
        gate,
        fetchImpl: destinationFetch,
      }),
    ).toEqual({ text, sourceUrl: url });
    expect(events).toEqual(["gate", "fetch"]);
    expect(destinationFetch.mock.calls[0]![0]).toBe(url);
    expect(destinationFetch.mock.calls[0]![1]?.redirect).toBe("error");
  });

  it("rejects unapproved destinations before reputation or network fetch", async () => {
    const gateFetch = vi.fn<typeof fetch>();
    const destinationFetch = vi.fn<typeof fetch>();
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl: gateFetch,
    });
    await expect(
      fetchExternalText({
        url: "http://127.0.0.1/internal",
        allowedUrls: ["https://example.test/approved"],
        gate,
        fetchImpl: destinationFetch,
      }),
    ).rejects.toMatchObject({ code: "input" });
    expect(gateFetch).not.toHaveBeenCalled();
    expect(destinationFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid UTF-8 without replacement characters or leaked bytes", async () => {
    const url = "https://example.test/approved";
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl: async () => Response.json(fixture("url-allow")),
    });
    const destinationFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { "content-type": "text/plain" },
        }),
    );
    await expect(
      fetchExternalText({
        url,
        allowedUrls: [url],
        gate,
        fetchImpl: destinationFetch,
      }),
    ).rejects.toMatchObject({
      code: "input",
      message: "IsMalicious gate refused (input)",
    });
  });

  it("rejects an unsupported declared charset rather than interpreting it as UTF-8", async () => {
    const url = "https://example.test/approved";
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl: async () => Response.json(fixture("url-allow")),
    });
    const destinationFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("text", {
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
        }),
    );
    await expect(
      fetchExternalText({
        url,
        allowedUrls: [url],
        gate,
        fetchImpl: destinationFetch,
      }),
    ).rejects.toMatchObject({ code: "input" });
  });
});
