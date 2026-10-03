import { readFileSync } from "node:fs";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import type { Processor } from "@mastra/core/processors";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateClient } from "../src/gate-client.js";
import type { ExternalText } from "../src/gate-client.js";
import {
  createUntrustedTextProcessor,
  fetchExternalText,
} from "../src/processor.js";
import { makeToolModel } from "./model.js";
import { createGuardedReaderAgent } from "../src/agent.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
const SENTINEL = "SYNTHETIC_UNTRUSTED_TOOL_TEXT_9347";
const ORIGINAL_URL = "https://example.test/a,b?next=x,y&key=a%2Fb#frag";
const original: ExternalText = { text: SENTINEL, sourceUrl: ORIGINAL_URL };
type Method = "generate" | "stream";
let logCalls: unknown[][];
beforeEach(() => {
  logCalls = [];
  for (const method of ["error", "warn", "info", "log", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logCalls.push(args);
    });
  }
});
afterEach(() => {
  expect(JSON.stringify(logCalls)).not.toContain(SENTINEL);
  expect(JSON.stringify(logCalls)).not.toContain("fixture-secret");
  expect(JSON.stringify(logCalls)).not.toContain(
    Buffer.from("fixture-key:fixture-secret").toString("base64"),
  );
  expect(JSON.stringify(logCalls)).not.toContain("remote text must not leak");
  vi.restoreAllMocks();
});

async function consume(agent: Agent, method: Method) {
  if (method === "generate")
    return agent.generate("Call the selected tool", { maxSteps: 3 });
  const stream = await agent.stream("Call the selected tool", { maxSteps: 3 });
  const chunks = [];
  for await (const chunk of stream.fullStream) chunks.push(chunk);
  return chunks;
}

describe.each<Method>(["generate", "stream"])("native Agent.%s", (method) => {
  it("rejects additional tool-result fields before forwarding unscanned data", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    });
    const { model, prompts } = makeToolModel();
    const externalReader = createTool({
      id: "externalReader",
      description: "Unsupported shape",
      inputSchema: z.object({}),
      execute: async () => ({ text: "plain text", extra: SENTINEL }),
    });
    const agent = new Agent({
      id: `extra-${method}`,
      name: "Strict shape test",
      instructions: "Use reader",
      model,
      tools: { externalReader },
      outputProcessors: [
        createUntrustedTextProcessor({ gate, toolNames: ["externalReader"] }),
      ],
    });
    const result = await consume(agent, method);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
  it("runs the complete configured reader with URL gate, fetch and content gate in order", async () => {
    const events: string[] = [];
    const gateFetch = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes("/gate/url?")) {
        events.push("url-gate");
        return Response.json(fixture("url-allow"));
      }
      events.push("content-gate");
      return Response.json(fixture("scan-allow-minimal"));
    });
    const destinationFetch = vi.fn<typeof fetch>(async () => {
      events.push("destination-fetch");
      return new Response(SENTINEL, {
        headers: { "content-type": "text/plain" },
      });
    });
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl: gateFetch,
    });
    const { model, prompts } = makeToolModel("externalReader", {
      url: ORIGINAL_URL,
    });
    const agent = createGuardedReaderAgent({
      model,
      gate,
      allowedUrls: [ORIGINAL_URL],
      fetchImpl: destinationFetch,
    });
    await consume(agent, method);
    expect(events).toEqual(["url-gate", "destination-fetch", "content-gate"]);
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain(SENTINEL);
  });
  it.each([
    ["block", () => Promise.resolve(Response.json(fixture("scan-block")))],
    ["warn", () => Promise.resolve(Response.json(fixture("scan-warn")))],
    [
      "HTTP 429",
      () =>
        Promise.resolve(Response.json(fixture("quota429"), { status: 429 })),
    ],
    [
      "HTTP 302",
      () =>
        Promise.resolve(
          new Response("", {
            status: 302,
            headers: { location: "https://other.test" },
          }),
        ),
    ],
    ["HTTP 500", () => Promise.resolve(new Response("", { status: 500 }))],
    [
      "malformed JSON",
      () => Promise.resolve(new Response("{bad", { status: 200 })),
    ],
    [
      "unknown verdict",
      () =>
        Promise.resolve(
          Response.json({
            ...(fixture("scan-allow-minimal") as object),
            verdict: "unknown",
          }),
        ),
    ],
    [
      "missing required fields",
      () => Promise.resolve(Response.json({ verdict: "allow" })),
    ],
    [
      "incomplete link inspection",
      () =>
        Promise.resolve(
          Response.json({
            ...(fixture("scan-allow-minimal") as object),
            links_truncated: true,
          }),
        ),
    ],
    [
      "network failure",
      () => Promise.reject(new Error("remote text must not leak")),
    ],
    [
      "timeout exception",
      () =>
        Promise.reject(
          new DOMException("remote text must not leak", "AbortError"),
        ),
    ],
  ])("refuses %s before the next model and history", async (_name, respond) => {
    const fetchImpl = vi.fn<typeof fetch>(respond);
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    });
    const { model, prompts } = makeToolModel();
    let snapshot: (() => unknown) | undefined;
    const observe = {
      id: "test-history-probe",
      processToolResult({ messageList }) {
        snapshot = () => messageList.get.all.db();
      },
    } satisfies Processor;
    const externalReader = createTool({
      id: "externalReader",
      description: "Return a synthetic external text result",
      inputSchema: z.object({}),
      execute: async () => original,
    });
    const agent = new Agent({
      id: `native-${method}`,
      name: "Native test",
      instructions: "Use the external reader",
      model,
      tools: { externalReader },
      outputProcessors: [
        observe,
        createUntrustedTextProcessor({ gate, toolNames: ["externalReader"] }),
      ],
    });
    const result = await consume(agent, method);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts)).not.toContain(SENTINEL);
    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot!())).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain("remote text must not leak");
  });

  it.each(["scan-allow-minimal", "scan-allow-unknown-link"])(
    "retains original result for %s",
    async (responseName) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json(fixture(responseName)),
      );
      const gate = createGateClient({
        apiKey: "fixture-key",
        apiSecret: "fixture-secret",
        fetchImpl,
      });
      const { model, prompts } = makeToolModel();
      let history: (() => unknown) | undefined;
      const observe = {
        id: "history-probe",
        processToolResult({ messageList }) {
          history = () => messageList.get.all.db();
        },
      } satisfies Processor;
      const externalReader = createTool({
        id: "externalReader",
        description: "Return selected text",
        inputSchema: z.object({}),
        execute: async () => original,
      });
      const agent = new Agent({
        id: `allow-${method}`,
        name: "Native allow test",
        instructions: "Use the reader",
        model,
        tools: { externalReader },
        outputProcessors: [
          observe,
          createUntrustedTextProcessor({ gate, toolNames: ["externalReader"] }),
        ],
      });
      await consume(agent, method);
      expect(prompts).toHaveLength(2);
      const resultPart = prompts[1]!
        .flatMap((message) =>
          Array.isArray(message.content) ? message.content : [],
        )
        .find((part) => part.type === "tool-result");
      expect(resultPart).toMatchObject({
        output: { type: "json", value: original },
      });
      expect(JSON.stringify(history!())).toContain(SENTINEL);
      expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual({
        content: SENTINEL,
        source_url: ORIGINAL_URL,
        mode: "fast",
      });
    },
  );

  it.each([
    ["block", () => Promise.resolve(Response.json(fixture("url-block")))],
    ["warn", () => Promise.resolve(Response.json(fixture("url-warn")))],
    ["HTTP 429", () => Promise.resolve(new Response("", { status: 429 }))],
    ["HTTP 302", () => Promise.resolve(new Response("", { status: 302 }))],
    ["malformed JSON", () => Promise.resolve(new Response("{bad"))],
    [
      "unknown verdict",
      () =>
        Promise.resolve(
          Response.json({
            ...(fixture("url-allow") as object),
            verdict: "unknown",
          }),
        ),
    ],
    [
      "network failure",
      () => Promise.reject(new Error("remote text must not leak")),
    ],
    [
      "timeout exception",
      () =>
        Promise.reject(
          new DOMException("remote text must not leak", "AbortError"),
        ),
    ],
  ])(
    "refuses URL %s before the native tool destination fetch",
    async (_name, respond) => {
      const gateFetch = vi.fn<typeof fetch>(respond);
      const destinationFetch = vi.fn<typeof fetch>();
      const gate = createGateClient({
        apiKey: "fixture-key",
        apiSecret: "fixture-secret",
        fetchImpl: gateFetch,
      });
      const { model } = makeToolModel("externalReader", { url: ORIGINAL_URL });
      const externalReader = createTool({
        id: "externalReader",
        description: "Fetch external text",
        inputSchema: z.object({ url: z.string() }),
        execute: async ({ url }) =>
          fetchExternalText({
            url,
            allowedUrls: [ORIGINAL_URL],
            gate,
            fetchImpl: destinationFetch,
          }),
      });
      const agent = new Agent({
        id: `url-${method}`,
        name: "URL test",
        instructions: "Use the reader",
        model,
        tools: { externalReader },
        outputProcessors: [
          createUntrustedTextProcessor({ gate, toolNames: ["externalReader"] }),
        ],
      });
      await consume(agent, method);
      expect(destinationFetch).not.toHaveBeenCalled();
      expect(gateFetch).toHaveBeenCalledTimes(1);
      expect(gateFetch.mock.calls[0]![0]).toBe(
        `https://api.ismalicious.com/gate/url?u=${encodeURIComponent(ORIGINAL_URL)}`,
      );
    },
  );

  it("never scans scanner tools or other unselected tools", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    });
    const { model, prompts } = makeToolModel("scan_before_use");
    const scan_before_use = createTool({
      id: "scan_before_use",
      description: "Synthetic scanner",
      inputSchema: z.object({}),
      execute: async () => original,
    });
    const agent = new Agent({
      id: `scanner-${method}`,
      name: "Scanner test",
      instructions: "Use scanner",
      model,
      tools: { scan_before_use },
      outputProcessors: [
        createUntrustedTextProcessor({ gate, toolNames: ["externalReader"] }),
      ],
    });
    await consume(agent, method);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(2);
    expect(() =>
      createUntrustedTextProcessor({ gate, toolNames: ["scan_before_use"] }),
    ).toThrow();
  });

  it("does not claim that exceptions from tool.execute pass the result hook", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const gate = createGateClient({
      apiKey: "fixture-key",
      apiSecret: "fixture-secret",
      fetchImpl,
    });
    const { model, prompts } = makeToolModel();
    const externalReader = createTool({
      id: "externalReader",
      description: "Throws",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("synthetic execute failure");
      },
    });
    const agent = new Agent({
      id: `exceptions-${method}`,
      name: "Exception scope",
      instructions: "Use reader",
      model,
      tools: { externalReader },
      outputProcessors: [
        createUntrustedTextProcessor({ gate, toolNames: ["externalReader"] }),
      ],
    });
    await consume(agent, method);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("synthetic execute failure");
  });
});
