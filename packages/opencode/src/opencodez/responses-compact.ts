import { Cause, Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { LLMNative } from "@/session/llm/native-request"
import { OpenCodezResponsesCompaction } from "./responses-compaction"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { ModelMessage } from "ai"

export type Result = {
  items: unknown[]
  usage: {
    total: number
    input: number
    output: number
    reasoning: number
  }
}

function toCompactInput(input: { model: Provider.Model; system: string[]; messages: ModelMessage[] }) {
  const request = LLMNative.request({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: {},
    // Compact input must remain self-contained under ZDR. Referencing
    // non-persisted reasoning items by rs_* id makes /responses/compact 404.
    providerOptions: { openai: { store: false } },
    headers: {},
  })
  return OpenAIResponses.protocol.body.from(request)
}

export function compact(input: {
  sessionID: string
  model: Provider.Model
  provider: Provider.Info
  system: string[]
  messages: readonly SessionV1.WithParts[]
  abort: AbortSignal
}) {
  return Effect.gen(function* () {
    const context = OpenCodezResponsesCompaction.tail(input.messages)
    let model = input.model.api.id
    let instructions = input.system.join("\n")
    let items = context.items.filter((item) => !isSystemMessage(item))
    if (context.messages.length > 0) {
      const messages = yield* MessageV2.toModelMessagesEffect(context.messages, input.model)
      if (messages.length > 0) {
        const body = yield* toCompactInput({
          model: input.model,
          system: input.system,
          messages,
        })
        if (!Array.isArray(body.input)) throw new Error("OpenAI compact input must be an array")
        model = body.model
        instructions = body.instructions ?? instructions
        items = [...items, ...body.input]
      }
    }

    const baseURL =
      typeof input.provider.options.baseURL === "string"
        ? input.provider.options.baseURL.replace(/\/$/, "")
        : "https://api.openai.com/v1"
    const fetcher = (
      typeof input.provider.options.fetch === "function" ? input.provider.options.fetch : fetch
    ) as typeof fetch
    const response = yield* Effect.tryPromise({
      try: () =>
        fetcher(`${baseURL}/responses/compact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            instructions,
            input: items,
          }),
          signal: input.abort,
        }),
      catch: (cause) => new Error("OpenAI remote compaction request failed", { cause }),
    })
    if (!response.ok) {
      const detail = yield* Effect.promise(() => response.text()).pipe(Effect.orElseSucceed(() => ""))
      throw new Error(`OpenAI remote compaction failed (${response.status})${detail ? `: ${detail}` : ""}`)
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) => new Error("OpenAI remote compaction returned invalid JSON", { cause }),
    })
    if (!isRecord(payload) || !Array.isArray(payload.output) || payload.output.length === 0) {
      throw new Error("OpenAI remote compaction returned no output items")
    }
    const usage = isRecord(payload.usage) ? payload.usage : {}
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
    return {
      items: payload.output,
      usage: {
        total: number(usage.total_tokens),
        input: number(usage.input_tokens),
        output: number(usage.output_tokens),
        reasoning: number(outputDetails.reasoning_tokens),
      },
    } satisfies Result
  }).pipe(Effect.catchCause((cause) => Effect.fail(Cause.squash(cause))))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isSystemMessage(value: unknown) {
  return isRecord(value) && value.type === "message" && value.role === "system"
}

export * as OpenCodezResponsesCompact from "./responses-compact"
