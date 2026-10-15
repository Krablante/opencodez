import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { jsonSchema, streamText, tool, type ModelMessage } from "ai"
import { Effect } from "effect"
import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { LLMRequestPrep } from "@/session/llm/request"
import { CodexAuthPlugin } from "@/plugin/openai/codex"
import { CodexResponsesCatalog } from "@/opencodez/codex-responses/catalog"
import { CodexResponsesCapability } from "@/opencodez/codex-responses/capability"
import { CodexResponsesCompact } from "@/opencodez/codex-responses/compact"
import { CodexResponsesCompaction } from "@/opencodez/codex-responses/compaction"
import { CodexResponsesProtocol } from "@/opencodez/codex-responses/protocol"
import { CodexResponsesTransport } from "@/opencodez/codex-responses/transport"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { isRecord } from "@/util/record"

const model: Provider.Model = {
  id: ModelV2.ID.make("gpt-6.1-sol"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "gpt-6.1-sol", npm: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  name: "Sol",
  family: "gpt-sol",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    interleaved: false,
    input: { text: true, image: true, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1050000, input: 872000, output: 128000 },
  options: {},
  headers: {},
  status: "active",
  release_date: "2026-09-29",
}
const profile: CodexResponsesCatalog.Profile = {
  modelID: model.api.id,
  contextWindow: 872000,
  maxContextWindow: 872000,
  autoCompactTokenLimit: 784800,
  compHash: "3000",
  responsesLite: true,
}
const user: ModelMessage = { role: "user", content: "Keep the current task" }
const assistant: ModelMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Work completed", providerOptions: { openai: { phase: "commentary" } } }],
}
const output = {
  type: "message",
  role: "assistant",
  phase: "commentary",
  content: [{ type: "output_text", text: "Work completed" }],
}
const opaque = { type: "compaction", encrypted_content: "compacted-state" }
type Capture = { via: "http" | "ws"; body: Record<string, unknown>; input: unknown[] }

function prepared(messages: ModelMessage[]): LLMRequestPrep.Prepared {
  return {
    codexResponses: true,
    codexResponsesProfile: profile,
    system: ["Keep these System instructions exactly once"],
    messages,
    tools: {
      inspect: tool({
        description: "Inspect state",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        strict: false,
      }),
    },
    toolChoice: "auto",
    params: {
      maxOutputTokens: 16000,
      options: {
        store: false,
        instructions: "Keep these System instructions exactly once",
        promptCacheKey: "compact-test",
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        serviceTier: "priority",
      },
    },
    messageTransformOptions: { store: false },
    headers: {
      [CodexResponsesCapability.HEADER]: "true",
      [CodexResponsesTransport.TURN_PROFILE_HEADER]: CodexResponsesCatalog.encodeProfile(profile),
      // A captured sampling handoff has already been consumed at this point.
      [CodexResponsesCompaction.HEADER]: "already-consumed",
    },
  }
}

async function sdkBody(input: LLMRequestPrep.Prepared) {
  let body: Record<string, unknown> | undefined
  const sdk = createOpenAI({
    apiKey: "test-key",
    fetch: Object.assign(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const value: unknown = JSON.parse(String(init?.body))
        if (!isRecord(value)) throw new Error("Expected SDK request body")
        body = value
        throw new Error("Request captured without sending")
      },
      { preconnect: fetch.preconnect },
    ),
  })
  await streamText({
    model: sdk.responses(model.api.id),
    messages: ProviderTransform.message(input.messages, model, input.messageTransformOptions),
    tools: input.tools,
    toolChoice: input.toolChoice,
    ...input.params,
    providerOptions: ProviderTransform.providerOptions(model, input.params.options),
    maxRetries: 0,
    onError() {},
  }).consumeStream()
  if (!body) throw new Error("SDK did not prepare a request")
  return body
}

async function fixture(options: { overflows?: number; streamOverflow?: boolean; httpOnly?: boolean } = {}) {
  const captures: Capture[] = []
  const id = crypto.randomUUID()
  let count = 0
  const events = (capture: Capture) => {
    const compact = capture.input.some((item) => isRecord(item) && item.type === "compaction_trigger")
    const failed = compact && ++count <= (options.overflows ?? 0)
    if (failed)
      return [
        {
          type: "response.failed",
          response: { error: { code: "context_length_exceeded", message: "Input exceeds context window" } },
        },
      ]
    const item = compact ? opaque : output
    return [
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: `resp_${crypto.randomUUID()}`,
          output: [item],
          usage: { input_tokens: 200, output_tokens: 10, total_tokens: 210 },
        },
      },
    ]
  }
  const capture = (value: unknown, via: Capture["via"]): Capture => {
    if (!isRecord(value) || !Array.isArray(value.input)) throw new Error("Invalid Responses request")
    const result = { via, body: value, input: value.input }
    captures.push(result)
    return result
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket") {
        if (options.httpOnly) return new Response("Use HTTP", { status: 426 })
        if (server.upgrade(request)) return
      }
      if (new URL(request.url).pathname.endsWith("models")) return Response.json({ models: [] })
      const entry = capture(await request.json(), "http")
      const output = events(entry)
      if (output[0]?.type === "response.failed" && !options.streamOverflow) {
        return Response.json(
          { error: { code: "context_length_exceeded", message: "Input exceeds context window" } },
          { status: 400 },
        )
      }
      return new Response(output.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    },
    websocket: {
      message(socket, message) {
        for (const event of events(capture(JSON.parse(message.toString()), "ws"))) socket.send(JSON.stringify(event))
      },
    },
  })
  const auth: Auth.Info = {
    type: "oauth",
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: Date.now() + 3600000,
    accountId: id,
  }
  const plugin = await CodexAuthPlugin({} as never, {
    codexApiEndpoint: `http://127.0.0.1:${server.port}/backend-api/codex/responses`,
  })
  if (!plugin.auth?.loader) throw new Error("Missing OAuth loader")
  const loaded = await plugin.auth.loader(async () => auth, { id: model.providerID, models: {} } as never)
  if (typeof loaded.fetch !== "function") throw new Error("Missing authenticated fetch")
  const fetcher: typeof fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const response: unknown = await loaded.fetch(url, init)
      if (!(response instanceof Response)) throw new Error("Invalid authenticated response")
      return response
    },
    { preconnect: fetch.preconnect },
  )
  const provider: Provider.Info = {
    id: model.providerID,
    name: "OpenAI",
    source: "custom",
    env: [],
    options: { fetch: fetcher },
    models: {},
  }
  return {
    captures,
    async send(body: Record<string, unknown>) {
      const response = await fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
        headers: {
          "x-session-affinity": id,
          "content-type": "application/json",
          [CodexResponsesCapability.HEADER]: "true",
          [CodexResponsesTransport.TURN_PROFILE_HEADER]: CodexResponsesCatalog.encodeProfile(profile),
          [CodexResponsesTransport.TURN_ID_HEADER]: "turn-test",
        },
      })
      await response.text()
    },
    compact(input: LLMRequestPrep.Prepared, items: unknown[] = []) {
      return Effect.runPromise(
        CodexResponsesCompact.compact({
          model,
          provider,
          prepared: input,
          items,
          sessionID: id,
          accountKey: CodexResponsesProtocol.accountKey(id, auth.access) ?? id,
          turnProfile: profile,
          windowID: id,
          turnID: "turn-test",
          compaction: { trigger: "auto", reason: "context_limit", phase: "mid_turn" },
          preserveActiveToolMedia: true,
          abort: AbortSignal.timeout(10000),
        }),
      )
    },
    async [Symbol.asyncDispose]() {
      await plugin.dispose?.()
      server.stop(true)
    },
  }
}

test("compact reuses the sampling wire and replaces the working window before continuing", async () => {
  await using server = await fixture()
  const sampling = prepared([user])
  await server.send(await sdkBody(sampling))
  const result = await server.compact(prepared([user, assistant]))
  const compact = server.captures.at(-1)
  expect(compact?.via).toBe("ws")
  expect(compact?.body.previous_response_id).toBeString()
  expect(compact?.input).toEqual([{ type: "compaction_trigger" }])
  expect(result.items).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the current task" }] },
    opaque,
  ])

  const next = await sdkBody(prepared([{ role: "user", content: "New tail" }]))
  if (!Array.isArray(next.input)) throw new Error("Missing input")
  next.input = [...result.items, ...next.input]
  await server.send(next)
  const reset = server.captures.at(-1)
  expect(reset?.body.previous_response_id).toBeUndefined()
  expect(reset?.input.some((item) => isRecord(item) && item.type === "compaction")).toBe(true)
  expect(JSON.stringify(reset?.input)).not.toContain("Work completed")

  const followup = structuredClone(next)
  if (!Array.isArray(followup.input)) throw new Error("Missing input")
  followup.input.push(output, { role: "user", content: [{ type: "input_text", text: "Next delta" }] })
  await server.send(followup)
  expect(server.captures.at(-1)?.body.previous_response_id).toBeString()
  expect(server.captures.at(-1)?.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "Next delta" }] },
  ])
})

test("large encrypted state cannot veto compact or preemptively clear tool results", async () => {
  await using server = await fixture()
  const messages: ModelMessage[] = [
    user,
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "summary",
          providerOptions: { openai: { itemId: "rs_test", reasoningEncryptedContent: "x".repeat(4200000) } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_test",
          toolName: "inspect",
          output: { type: "text", value: "Complete tool work" },
        },
      ],
    },
  ]
  const result = await server.compact(prepared(messages))
  expect(result.trimmedOutputs).toBe(0)
  expect(server.captures).toHaveLength(1)
  expect(JSON.stringify(server.captures[0]?.input)).toContain("Complete tool work")
})

test("compact matches sampling with split reasoning, phased text, and tool media", async () => {
  await using server = await fixture()
  const history: ModelMessage[] = [
    user,
    {
      role: "assistant",
      content: [
        ...["First summary", "Second summary"].map((text) => ({
          type: "reasoning" as const,
          text,
          providerOptions: { openai: { itemId: "rs_split", reasoningEncryptedContent: "encrypted-reasoning" } },
        })),
        { type: "text", text: "Inspecting", providerOptions: { openai: { phase: "commentary" } } },
        { type: "tool-call", toolCallId: "call_image", toolName: "inspect", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_image",
          toolName: "inspect",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Current image" },
              { type: "media", mediaType: "image/png", data: "AQID" },
            ],
          },
        },
      ],
    },
  ]
  await server.send(await sdkBody(prepared(history)))
  await server.compact(prepared([...history, assistant]))
  expect(server.captures.at(-1)?.body.previous_response_id).toBeString()
  expect(server.captures.at(-1)?.input).toEqual([{ type: "compaction_trigger" }])
})

for (const httpOnly of [false, true]) {
  test(`confirmed ${httpOnly ? "HTTP" : "stream"} overflow bounds tool text once and preserves active images`, async () => {
    await using server = await fixture({ overflows: 1, httpOnly, streamOverflow: !httpOnly })
    const messages: ModelMessage[] = [
      user,
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "summary",
            providerOptions: { openai: { itemId: "rs_test", reasoningEncryptedContent: "x".repeat(4200000) } },
          },
        ],
      },
      {
        role: "tool",
        content: ["first", "second"].map((id) => ({
          type: "tool-result",
          toolCallId: id,
          toolName: "inspect",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Tool result ".repeat(1000) },
              { type: "media", mediaType: "image/png", data: "AQID" },
            ],
          },
        })),
      },
    ]
    const result = await server.compact(prepared(messages))
    expect(result.trimmedOutputs).toBe(2)
    expect(server.captures).toHaveLength(2)
    for (const entry of server.captures) {
      const outputs = entry.input.filter((item) => isRecord(item) && item.type === "function_call_output")
      expect(outputs).toHaveLength(2)
      for (const item of outputs) {
        if (!isRecord(item) || !Array.isArray(item.output)) throw new Error("Tool media was serialized as text")
        expect(item.output).toContainEqual({ type: "input_image", image_url: "data:image/png;base64,AQID" })
      }
    }
    expect(JSON.stringify(server.captures[1]?.input)).not.toContain("Tool result Tool result")
    expect(server.captures[1]?.body.previous_response_id).toBeUndefined()
  })
}

test("a second provider overflow stops without an unbounded compact loop", async () => {
  await using server = await fixture({ overflows: 10 })
  const input = prepared([
    user,
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "summary",
          providerOptions: { openai: { itemId: "rs_test", reasoningEncryptedContent: "x".repeat(4200000) } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_test",
          toolName: "inspect",
          output: { type: "text", value: "Tool result ".repeat(1000) },
        },
      ],
    },
  ])
  await expect(server.compact(input)).rejects.toThrow("Input exceeds context window")
  expect(server.captures).toHaveLength(2)
})

test("provider overflow still reduces an output when the local estimate is below target", async () => {
  await using server = await fixture({ overflows: 1 })
  const result = await server.compact(
    prepared([
      user,
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_test",
            toolName: "inspect",
            output: { type: "text", value: "Tool result ".repeat(1000) },
          },
        ],
      },
    ]),
  )
  expect(result.trimmedOutputs).toBe(1)
  expect(server.captures).toHaveLength(2)
})
