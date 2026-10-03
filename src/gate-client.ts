import { z } from "zod";

export const GATE_TIMEOUT_MS = 15_000;
export const MAX_SCAN_BODY_BYTES = 1024 * 1024;
const verdict = z.enum(["block", "warn", "allow"]);
const link = z
  .object({
    url: z.string(),
    entity: z.string(),
    verdict: z.enum(["malicious", "suspicious", "clean", "unknown"]),
    sources: z.number().int().nonnegative(),
  })
  .passthrough();
const span = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    family: z.string(),
  })
  .passthrough();
const scanResponse = z
  .object({
    verdict,
    injection: z
      .object({
        score: z.number().min(0).max(1),
        families: z.array(z.string()),
        spans: z.array(span),
      })
      .passthrough(),
    links: z.array(link),
    links_truncated: z.boolean(),
    mode: z.literal("fast"),
    latency_ms: z.number().int().nonnegative(),
    source: link.nullable().optional(),
    sanitized_content: z.string().nullable().optional(),
  })
  .passthrough();
const urlResponse = z
  .object({
    url: z.string(),
    entity: z.string(),
    verdict,
    sources: z.number().int().nonnegative(),
    latency_ms: z.number().int().nonnegative(),
  })
  .passthrough();

export type ScanResponse = z.infer<typeof scanResponse>;
export type UrlResponse = z.infer<typeof urlResponse>;
export interface ExternalText {
  text: string;
  sourceUrl?: string;
}
export interface Gate {
  scan(content: ExternalText): Promise<ScanResponse>;
  checkUrl(url: string): Promise<UrlResponse>;
}

export class GateFailure extends Error {
  constructor(
    readonly code: "input" | "transport" | "http" | "response" | "policy",
  ) {
    super(`IsMalicious gate refused (${code})`);
    this.name = "GateFailure";
  }
}

/** This is a policy decision, not a statement that allowed data is benign. */
export function requireAllow(response: {
  verdict: "block" | "warn" | "allow";
}): void {
  if (response.verdict !== "allow") throw new GateFailure("policy");
}

export function validateHttpUrl(original: string): void {
  try {
    const parsed = new URL(original);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
  } catch {
    throw new GateFailure("input");
  }
}

/** Requests never redirect, retry, or include remote response bodies in errors. */
export function createGateClient({
  apiKey,
  apiSecret,
  fetchImpl = fetch,
}: {
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
}): Gate {
  if (!apiKey || !apiSecret) throw new GateFailure("input");
  const authorization = Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString(
    "base64",
  );

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`https://api.ismalicious.com${path}`, {
        ...init,
        headers: {
          "X-API-KEY": authorization,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected) throw new GateFailure("http");
      try {
        return await response.json();
      } catch {
        throw new GateFailure("response");
      }
    } catch (error) {
      if (error instanceof GateFailure) throw error;
      throw new GateFailure("transport");
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async scan({ text, sourceUrl }) {
      if (!text.trim()) throw new GateFailure("input");
      if (sourceUrl !== undefined) validateHttpUrl(sourceUrl);
      const body = JSON.stringify({
        content: text,
        source_url: sourceUrl,
        mode: "fast",
      });
      if (Buffer.byteLength(body, "utf8") > MAX_SCAN_BODY_BYTES)
        throw new GateFailure("input");
      const parsed = scanResponse.safeParse(
        await request("/gate/scan", { method: "POST", body }),
      );
      if (!parsed.success) throw new GateFailure("response");
      return parsed.data;
    },
    async checkUrl(original) {
      validateHttpUrl(original);
      const parsed = urlResponse.safeParse(
        await request(`/gate/url?u=${encodeURIComponent(original)}`),
      );
      if (!parsed.success) throw new GateFailure("response");
      return parsed.data;
    },
  };
}
