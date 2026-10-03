# IsMalicious text gate example for Mastra

This independent example checks an operator-approved URL before a local Mastra reader fetches it, then checks the returned text with a `processToolResult` output processor. A refused result stops the run before it enters the message list or a subsequent model call. The scanner is called by application code, rather than offered to the model as an optional tool.

This repository is a supplier-owned feasibility example. It is not an official Mastra integration. An upstream feature request requires maintainer feedback before an examples or documentation PR.

## Run the offline validation

Use Node.js 22.13.0 or newer and pnpm 10.33.0:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

The tests use the actual published `@mastra/core@1.74.0`, real `Agent.generate`, real `Agent.stream`, real `createTool`, and the actual output-processor execution pipeline. Only the language-model provider and HTTP transport return synthetic responses. No LLM key or IsMalicious key is needed, and no production API call is made. Fixtures validate protocol and policy handling, not detector accuracy.

The inspected upstream checkout was `mastra-ai/mastra` commit `20c9a8cb991473e8644598ab8b1e5ee61cc6865b`, whose core package is `1.75.0-alpha.2`. Tests do not claim that development version was built. CI runs the locked published package on Node.js 22 and 24.

## Configure the application

`src/agent.ts` exports `createGuardedReaderAgent`. Pass your existing Mastra model configuration, a client from `src/gate-client.ts`, and exact URLs selected by an operator before the run:

```typescript
import { createGateClient } from "./src/gate-client.js";
import { createGuardedReaderAgent } from "./src/agent.js";

const gate = createGateClient({
  apiKey: process.env.ISMALICIOUS_API_KEY ?? "",
  apiSecret: process.env.ISMALICIOUS_API_SECRET ?? "",
});

// configuredModel is the model configuration already used by your application.
const agent = createGuardedReaderAgent({
  model: configuredModel,
  gate,
  allowedUrls: ["https://example.com/approved-source"],
});

const response = await agent.generate("Read the approved source", {
  maxSteps: 3,
});
```

Get API credentials from [your IsMalicious account](https://ismalicious.com/app/account). Put them in environment variables or your secret manager. The client sends `X-API-KEY: Base64(key:secret)` only to `https://api.ismalicious.com`, disables redirects, uses a 15-second timeout and performs no retries. Gate requests consume the separate scan quota, which differs from `/check` request usage. Check your account for current limits.

The gate receives the selected text and its source URL, and the URL reputation endpoint receives each selected destination. Decide whether sending that data to the service fits your application before enabling the reader. The adapter does not log request text, credentials, or response bodies. Its errors use fixed messages; tests inspect console output for sensitive fixture values.

## Policy and coverage

| Condition                                                                                 | Action                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Top-level `block` or `warn`                                                               | Refuse, with no operator override in this example  |
| Valid top-level `allow` and complete link inspection                                      | Keep the exact original tool result                |
| `links_truncated: true`                                                                   | Refuse incomplete inspection                       |
| HTTP failure including 429 or 302, malformed response, unknown top-level verdict, timeout | Refuse; do not retry                               |
| Inner link verdict `unknown` inside a valid `allow`                                       | Preserve the record; follow the top-level decision |
| Oversized JSON scan request                                                               | Refuse before sending; do not truncate             |
| Unsupported MIME type, declared encoding, or invalid UTF-8                                | Refuse before returning text                       |
| Selected result contains fields other than `text` and optional `sourceUrl`                | Refuse before forwarding unscanned fields          |
| Destination outside the operator's exact URL list                                         | Refuse before the reputation request or fetch      |

`allow` means the gate did not block under its current rules. It does not establish that text or a destination is benign. The current backend can map unknown link reputation to top-level `allow`. The URL gate is not an SSRF filter or proof of a public address. The exact operator list bounds the example's destination choices; production deployments still need their own network egress policy, including DNS and address controls appropriate to their infrastructure.

The client requests `mode: fast` and accepts `mode: fast` responses. The API also reserves `thorough`, which currently behaves like `fast`; this example makes no stronger-detection claim. It never substitutes `sanitized_content` for the original as a universal safe replacement.

Coverage is limited to selected local tools returning bounded, non-streaming `{ text, sourceUrl? }` objects. The included reader supports UTF-8 `text/plain`, `text/html` and `application/json` bodies, with a 1 MiB body bound; JSON request overhead may make the accepted text smaller. URL strings retain commas, query values and fragments exactly. No redirect destination is fetched.

`processToolResult` does not run when `tool.execute()` throws. Tests show that those exceptions can reach a subsequent model call as tool errors without scanning. URL rejection prevents the destination fetch, but its thrown error does not itself promise an agent-wide abort. Deferred provider results, provider-hosted tools, durable agents, remote MCP executors, arbitrary tools, file/image/binary content, general streaming tool bodies and detector effectiveness are not validated by this example. Adding a scanner MCP tool alone does not enforce this policy.

The tests assert both allowed-result preservation and refused-result absence from the next model prompt, message list and returned stream. They also exercise URL refusal before fetch, response failures, timeout signals, the complete gate-fetch-scan sequence, and scanner exclusion. Selecting known scanner tool names as targets is rejected; only the explicitly selected reader is scanned.

## Contribution status

An upstream PR will wait for Mastra maintainer scope approval and the required triage state under [Mastra's contribution rules](https://github.com/mastra-ai/mastra/blob/main/CONTRIBUTING.md). The new supplier example uses existing extension points and makes no core API changes.

This contribution was prepared with AI assistance. It is published by the IsMalicious maintainer account, `hexablob`; that affiliation is intentional and disclosed.
