import { Cause, Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { LLMNative } from "@/session/llm/native-request"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { ProviderTransform } from "@/provider/transform"
import { Token } from "@/util/token"
import type { ModelMessage, Tool } from "ai"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"

export type Result = {
  items: unknown[]
  trimmedOutputs: number
  usage: {
    total: number
    input: number
    output: number
    reasoning: number
  }
}

const TRUNCATED_OUTPUT = "Output exceeded the available model context and was truncated"
// Match Codex's conservative estimate for an automatically resized image input.
// Counting inline base64 as text can overstate one screenshot by hundreds of
// thousands of tokens and trigger compaction while the provider still has room.
const IMAGE_INPUT_TOKENS = 1_844
// Codex calls its byte-based history estimate a lower bound and also caps every
// tool output when recording it. OpenCode keeps the durable output verbatim, so
// apply the missing safety margin only to the disposable compact request copy.
const COMPACT_ESTIMATE_SAFETY_FACTOR = 2

function toCompactInput(input: {
  model: Provider.Model
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  options: Record<string, unknown>
}) {
  const request = LLMNative.request({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    // Compact input must remain self-contained under ZDR. Referencing
    // non-persisted reasoning items by rs_* id makes /responses/compact 404.
    providerOptions: ProviderTransform.providerOptions(input.model, { ...input.options, store: false }),
    headers: {},
  })
  return OpenAIResponses.protocol.body.from(request)
}

export function compact(input: {
  model: Provider.Model
  provider: Provider.Info
  system: string[]
  messages: ModelMessage[]
  tools: Record<string, Tool>
  options: Record<string, unknown>
  items: unknown[]
  abort: AbortSignal
}) {
  return Effect.gen(function* () {
    const body = yield* toCompactInput(input)
    if (!Array.isArray(body.input)) throw new Error("OpenAI compact input must be an array")
    const request = compactBody(body, [...input.items.filter((item) => !isSystemMessage(item)), ...body.input])
    const bounded = trimOutputs(request, OpenCodezSettings.responsesCompactionPayloadLimit(input.model.limit))
    if (bounded.rewritten > 0) {
      yield* Effect.logInfo("bounded remote compaction tool outputs", {
        count: bounded.rewritten,
        estimated_tokens: bounded.estimate,
        limit: bounded.limit,
      })
    }

    const baseURL =
      typeof input.provider.options.baseURL === "string"
        ? input.provider.options.baseURL.replace(/\/$/, "")
        : "https://api.openai.com/v1"
    const fetcher: typeof fetch =
      typeof input.provider.options.fetch === "function" ? input.provider.options.fetch : fetch
    const payload = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(`${baseURL}/responses/compact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.any([signal, input.abort]),
        }).then((response) => {
          if (!response.ok) {
            return response
              .text()
              .catch(() => "")
              .then((detail) => {
                throw new Error(`OpenAI remote compaction failed (${response.status})${detail ? `: ${detail}` : ""}`)
              })
          }
          return response.json().catch((cause) => {
            throw new Error("OpenAI remote compaction returned invalid JSON", { cause })
          }) as Promise<unknown>
        }),
      catch: (cause) =>
        cause instanceof Error && cause.message.startsWith("OpenAI remote compaction")
          ? cause
          : new Error("OpenAI remote compaction request failed", { cause }),
    })
    if (!isRecord(payload) || !Array.isArray(payload.output) || payload.output.length === 0) {
      throw new Error("OpenAI remote compaction returned no output items")
    }
    const items = payload.output.filter(keepOutputItem)
    if (items.length === 0) throw new Error("OpenAI remote compaction returned no supported output items")
    const usage = isRecord(payload.usage) ? payload.usage : {}
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
    return {
      items,
      trimmedOutputs: bounded.rewritten,
      usage: {
        total: number(usage.total_tokens),
        input: number(usage.input_tokens),
        output: number(usage.output_tokens),
        reasoning: number(outputDetails.reasoning_tokens),
      },
    } satisfies Result
  }).pipe(Effect.catchCause((cause) => Effect.fail(Cause.squash(cause))))
}

function compactBody(body: Record<string, unknown>, items: unknown[]) {
  const result: Record<string, unknown> & { input: unknown[] } = {
    model: body.model,
    input: items,
  }
  for (const key of [
    "instructions",
    "tools",
    "parallel_tool_calls",
    "reasoning",
    "service_tier",
    "prompt_cache_key",
    "text",
  ]) {
    if (body[key] !== undefined) result[key] = body[key]
  }
  return result
}

function trimOutputs(body: Record<string, unknown> & { input: unknown[] }, contextWindow: number) {
  if (contextWindow <= 0) return { rewritten: 0, estimate: 0, limit: contextWindow }
  let estimate = estimateInput(body) * COMPACT_ESTIMATE_SAFETY_FACTOR
  let rewritten = 0
  const indexes = body.input.flatMap((item, index) => (isToolOutput(item) ? [index] : []))
  const latest = indexes.at(-1)
  const candidates = indexes
    .flatMap((index) => {
      const item = body.input[index]
      if (!isRecord(item)) return []
      const replacement = rewriteOutput(item, index === latest)
      return [
        {
          index,
          replacement,
          saved: (estimateInput(item) - estimateInput(replacement)) * COMPACT_ESTIMATE_SAFETY_FACTOR,
        },
      ]
    })
    .filter((candidate) => candidate.saved > 0)
    .toSorted((a, b) => {
      const newest = Number(a.index === latest) - Number(b.index === latest)
      if (newest !== 0) return newest
      return b.saved - a.saved || a.index - b.index
    })
  for (const candidate of candidates) {
    if (estimate <= contextWindow) break
    body.input[candidate.index] = candidate.replacement
    rewritten++
    estimate = Math.max(0, estimate - candidate.saved)
  }
  return { rewritten, estimate, limit: contextWindow }
}

function isToolOutput(value: unknown) {
  if (!isRecord(value)) return false
  return (
    value.type === "function_call_output" ||
    value.type === "custom_tool_call_output" ||
    value.type === "tool_search_output"
  )
}

function rewriteOutput(item: Record<string, unknown>, preserveMedia: boolean) {
  if (item.type === "tool_search_output") return { ...item, tools: [] }
  if (!preserveMedia || !Array.isArray(item.output)) return { ...item, output: TRUNCATED_OUTPUT }
  const media = item.output.filter((part) => isRecord(part) && part.type === "input_image")
  return {
    ...item,
    output: [{ type: "input_text", text: TRUNCATED_OUTPUT }, ...media],
  }
}

export function estimateInput(value: unknown) {
  let estimate = Token.estimate(JSON.stringify(value))
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const payload = inlineImagePayload(item)
      if (payload) estimate = Math.max(0, estimate - Token.estimate(payload) + IMAGE_INPUT_TOKENS)
      return
    }
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (!isRecord(item)) return
    Object.values(item).forEach(visit)
  }
  visit(value)
  return estimate
}

function inlineImagePayload(value: string) {
  const comma = value.indexOf(",")
  if (comma < 0) return undefined
  const metadata = value.slice(0, comma).toLowerCase()
  if (!metadata.startsWith("data:image/") || !metadata.includes(";base64")) return undefined
  return value.slice(comma + 1)
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

function keepOutputItem(value: unknown) {
  if (!isRecord(value)) return false
  // The ChatGPT legacy compact endpoint serializes Codex's context-compaction
  // item as compaction_summary. Keep both current and legacy wire names.
  if (
    value.type === "compaction" ||
    value.type === "compaction_summary" ||
    value.type === "context_compaction" ||
    value.type === "agent_message"
  )
    return true
  return value.type === "message" && (value.role === "user" || value.role === "assistant")
}

export * as OpenCodezResponsesCompact from "./responses-compact"
