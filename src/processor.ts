import type { Processor, ProcessToolResultArgs } from "@mastra/core/processors";
import { z } from "zod";
import { GateFailure, requireAllow, validateHttpUrl } from "./gate-client.js";
import type { ExternalText, Gate } from "./gate-client.js";

const externalText = z
  .object({ text: z.string().min(1), sourceUrl: z.string().optional() })
  .strict();
const scannerTools = new Set(["scan_before_use", "check_url", "scan_email"]);
export interface UntrustedTextProcessor extends Processor {
  processToolResult(args: ProcessToolResultArgs): Promise<void>;
}

/** Select only tools that return bounded, non-streaming ExternalText objects. */
export function createUntrustedTextProcessor({
  gate,
  toolNames,
}: {
  gate: Gate;
  toolNames: readonly string[];
}): UntrustedTextProcessor {
  if (toolNames.some((name) => scannerTools.has(name)))
    throw new GateFailure("input");
  const selected = new Set(toolNames);
  return {
    id: "ismalicious-untrusted-text",
    async processToolResult({ toolName, result, abort }) {
      if (!selected.has(toolName)) return;
      const parsed = externalText.safeParse(result);
      if (!parsed.success)
        return abort("IsMalicious gate refused unsupported tool result");
      try {
        const response = await gate.scan(parsed.data);
        requireAllow(response);
        if (response.links_truncated) throw new GateFailure("response");
      } catch {
        return abort("IsMalicious gate refused selected tool result");
      }
      // Keep the exact original value. sanitized_content is not a safe replacement.
    },
  };
}

/** URL decisions happen before the selected destination is requested. */
export async function fetchExternalText({
  url,
  allowedUrls,
  gate,
  fetchImpl = fetch,
}: {
  url: string;
  allowedUrls: readonly string[];
  gate: Gate;
  fetchImpl?: typeof fetch;
}): Promise<ExternalText> {
  if (!allowedUrls.includes(url)) throw new GateFailure("input");
  validateHttpUrl(url);
  requireAllow(await gate.checkUrl(url));
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || response.redirected) throw new GateFailure("http");
  const contentTypeHeader = response.headers.get("content-type") ?? "";
  const contentType =
    contentTypeHeader.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!["text/plain", "text/html", "application/json"].includes(contentType))
    throw new GateFailure("input");
  const charset = contentTypeHeader
    .match(/;\s*charset\s*=\s*"?([^;\s"]+)/i)?.[1]
    ?.toLowerCase();
  if (charset && !["utf-8", "utf8"].includes(charset))
    throw new GateFailure("input");
  // Read a bounded body without silently truncating and claiming full inspection.
  const reader = response.body?.getReader();
  if (!reader) throw new GateFailure("input");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) {
      await reader.cancel();
      throw new GateFailure("input");
    }
    chunks.push(value);
  }
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      ),
      sourceUrl: url,
    };
  } catch {
    throw new GateFailure("input");
  }
}
