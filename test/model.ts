import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";

/** Synthetic provider, while execution, tools and processors are real Mastra. */
export function makeToolModel(
  toolName = "externalReader",
  input: unknown = {},
) {
  const prompts: LanguageModelV2CallOptions["prompt"][] = [];
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "synthetic",
    modelId: "tool-boundary-validation",
    supportedUrls: {},
    async doGenerate(options) {
      prompts.push(structuredClone(options.prompt));
      return {
        content:
          prompts.length === 1
            ? [
                {
                  type: "tool-call",
                  toolCallId: "external-1",
                  toolName,
                  input: JSON.stringify(input),
                },
              ]
            : [{ type: "text", text: "complete" }],
        finishReason: prompts.length === 1 ? "tool-calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
    async doStream(options) {
      prompts.push(structuredClone(options.prompt));
      const parts: LanguageModelV2StreamPart[] = [
        { type: "stream-start", warnings: [] },
        ...(prompts.length === 1
          ? [
              {
                type: "tool-call" as const,
                toolCallId: "external-1",
                toolName,
                input: JSON.stringify(input),
              },
            ]
          : [
              { type: "text-start" as const, id: "text-1" },
              { type: "text-delta" as const, id: "text-1", delta: "complete" },
              { type: "text-end" as const, id: "text-1" },
            ]),
        {
          type: "finish",
          finishReason: prompts.length === 1 ? "tool-calls" : "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  return { model, prompts };
}
