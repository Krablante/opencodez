import { Cause, Effect, Schedule } from "effect"
import type { Provider } from "@/provider/provider"
import { LLMNative } from "@/session/llm/native-request"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { ProviderTransform } from "@/provider/transform"
import { Token } from "@/util/token"
import type { ModelMessage, Tool } from "ai"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { OpenAIWebSocketPool } from "@/plugin/openai/ws-pool"
import { OpenCodezResponsesPolicy } from "./responses-policy"

export type Result = {
  items: Record<string, unknown>[]
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
const ORIGINAL_IMAGE_MAX_TOKENS = 10_000
const RETAINED_MESSAGE_TOKEN_BUDGET = 64_000

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
    // Compact input must remain self-contained under ZDR. A streamed V2
    // compaction cannot rehydrate non-persisted reasoning items by rs_* id.
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
  sessionID: string
  turnID?: string
  preserveActiveToolMedia: boolean
  abort: AbortSignal
}) {
  return Effect.gen(function* () {
    const body = yield* toCompactInput(input)
    if (!Array.isArray(body.input)) throw new Error("OpenAI compact input must be an array")
    const request = compactBody(body, [...input.items.filter((item) => !isSystemMessage(item)), ...body.input])
    const bounded = trimOutputs(
      request,
      OpenCodezSettings.responsesCompactionPayloadLimit(input.model.limit),
      input.preserveActiveToolMedia,
    )
    if (bounded.rewritten > 0) {
      yield* Effect.logInfo("bounded remote compaction tool outputs", {
        count: bounded.rewritten,
        estimated_tokens: bounded.estimate,
        limit: bounded.limit,
      })
    }
    if (bounded.estimate > bounded.limit) {
      throw new Error(
        `OpenAI remote compaction input exceeds the safe request window after bounding tool outputs (${bounded.estimate} > ${bounded.limit} tokens)`,
      )
    }

    const baseURL =
      typeof input.provider.options.baseURL === "string"
        ? input.provider.options.baseURL.replace(/\/$/, "")
        : "https://api.openai.com/v1"
    const fetcher: typeof fetch =
      typeof input.provider.options.fetch === "function" ? input.provider.options.fetch : fetch
    const payload = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(`${baseURL}/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session-affinity": input.sessionID,
            ...(input.turnID ? { [OpenAIWebSocketPool.TURN_ID_HEADER]: input.turnID } : {}),
            [OpenCodezResponsesPolicy.REQUEST_KIND_HEADER]: "compaction",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.any([signal, input.abort]),
        }).then(async (response) => {
          if (!response.ok) {
            const detail = await response.text().catch(() => "")
            throw new RemoteCompactionError(
              `OpenAI remote compaction failed (${response.status})${detail ? `: ${detail}` : ""}`,
              response.status === 429 || response.status >= 500,
            )
          }
          return parseCompactionResponse(response, request.input)
        }),
      catch: (cause) =>
        cause instanceof RemoteCompactionError
          ? cause
          : new RemoteCompactionError(
              "OpenAI remote compaction request failed",
              !(cause instanceof DOMException && cause.name === "AbortError"),
              { cause },
            ),
    }).pipe(
      Effect.retry({
        times: OpenCodezResponsesPolicy.streamRetryLimit("compaction"),
        schedule: Schedule.exponential("500 millis"),
        while: (error) => error.retryable,
      }),
    )
    return {
      items: payload.items,
      trimmedOutputs: bounded.rewritten,
      usage: payload.usage,
    } satisfies Result
  }).pipe(Effect.catchCause((cause) => Effect.fail(Cause.squash(cause))))
}

function compactBody(body: Record<string, unknown>, items: unknown[]) {
  const result: Record<string, unknown> & { input: unknown[] } = {
    ...body,
    input: [...items, { type: "compaction_trigger" }],
    store: false,
    stream: true,
  }
  delete result.background
  delete result.previous_response_id
  return result
}

function trimOutputs(
  body: Record<string, unknown> & { input: unknown[] },
  contextWindow: number,
  preserveActiveToolMedia: boolean,
) {
  if (contextWindow <= 0) return { rewritten: 0, estimate: 0, limit: contextWindow }
  // The coarse JSON estimate is reliable for ordinary text and media after
  // image adjustment. Only tool output gets a second conservative charge:
  // unlike Codex, OpenCode stores those items verbatim without a hard cap.
  let estimate =
    estimateInput(body) +
    body.input
      .map((item) => (isToolOutput(item) ? estimateInput(item) : 0))
      .reduce((total, tokens) => total + tokens, 0)
  let rewritten = 0
  const indexes = body.input.flatMap((item, index) => (isToolOutput(item) ? [index] : []))
  const latest = indexes.at(-1)
  const activeTurn = preserveActiveToolMedia
    ? body.input.findLastIndex((item) => isRecord(item) && item.type === "message" && item.role === "user")
    : -1
  const candidates = indexes
    .flatMap((index) => {
      const item = body.input[index]
      if (!isRecord(item)) return []
      const replacement = rewriteOutput(item, index === latest || (activeTurn >= 0 && index > activeTurn))
      return [
        {
          index,
          replacement,
          saved: (estimateInput(item) - estimateInput(replacement)) * 2,
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
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (!isRecord(item)) return
    if (item.type === "input_image" && typeof item.image_url === "string") {
      const payload = inlineImagePayload(item.image_url)
      if (payload) {
        estimate =
          Math.max(0, estimate - Token.estimate(payload)) +
          (item.detail === "original" ? ORIGINAL_IMAGE_MAX_TOKENS : IMAGE_INPUT_TOKENS)
        return
      }
    }
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

async function parseCompactionResponse(response: Response, input: unknown[]) {
  if (!response.body) throw new RemoteCompactionError("OpenAI remote compaction returned an empty stream", true)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const output: Record<string, unknown>[] = []
  let completed: Record<string, unknown> | undefined
  let buffer = ""

  const consume = (event: Record<string, unknown>) => {
    if (
      ["error", "response.failed", "response.incomplete"].includes(typeof event.type === "string" ? event.type : "")
    ) {
      const error = isRecord(event.error)
        ? event.error
        : isRecord(event.response) && isRecord(event.response.error)
          ? event.response.error
          : undefined
      const detail =
        typeof error?.message === "string"
          ? error.message
          : typeof event.type === "string"
            ? event.type
            : "unknown error"
      throw new RemoteCompactionError(
        `OpenAI remote compaction failed: ${detail}`,
        OpenCodezResponsesPolicy.retryableEvent(event),
      )
    }
    if (event.type === "response.output_item.done" && isCompactionItem(event.item)) output.push(event.item)
    if (event.type === "response.completed" || event.type === "response.done") completed = event
  }

  const drain = (final: boolean) => {
    while (true) {
      const separator = /\r?\n\r?\n/.exec(buffer)
      if (!separator) break
      const block = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator[0].length)
      const event = parseEvent(block)
      if (event) consume(event)
    }
    if (!final || !buffer.trim()) return
    const event = parseEvent(buffer)
    buffer = ""
    if (event) consume(event)
  }

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      drain(false)
    }
    buffer += decoder.decode()
    drain(true)
  } catch (cause) {
    await reader.cancel(cause).catch(() => {})
    throw cause
  } finally {
    reader.releaseLock()
  }

  if (output.length !== 1) {
    throw new RemoteCompactionError(
      `OpenAI remote compaction expected exactly one compaction item, received ${output.length}`,
      false,
    )
  }
  if (!completed) throw new RemoteCompactionError("OpenAI remote compaction stream ended before completion", true)
  const payload = isRecord(completed.response) ? completed.response : {}
  const usage = isRecord(payload.usage) ? payload.usage : {}
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {}
  return {
    items: [...retainUserMessages(input.slice(0, -1)), output[0]],
    usage: {
      total: number(usage.total_tokens),
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      reasoning: number(outputDetails.reasoning_tokens),
    },
  }
}

function parseEvent(block: string) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return undefined
  try {
    const event: unknown = JSON.parse(data)
    return isRecord(event) ? event : undefined
  } catch (cause) {
    throw new RemoteCompactionError("OpenAI remote compaction returned invalid event JSON", false, { cause })
  }
}

function retainUserMessages(input: unknown[]): Record<string, unknown>[] {
  let remaining = RETAINED_MESSAGE_TOKEN_BUDGET
  const retained: Record<string, unknown>[] = []
  for (const item of input.toReversed()) {
    if (!isRecord(item) || item.type !== "message" || item.role !== "user") continue
    if (remaining <= 0) break
    const estimate = Math.max(1, estimateInput(item))
    if (estimate <= remaining) {
      retained.push(item)
      remaining -= estimate
      continue
    }
    const truncated = truncateMessage(item, remaining)
    if (truncated) retained.push(truncated)
    remaining = 0
  }
  return retained.reverse()
}

function truncateMessage(item: Record<string, unknown>, tokens: number) {
  if (!Array.isArray(item.content) || tokens <= 0) return undefined
  let remaining = tokens
  const content = item.content.flatMap((part) => {
    if (!isRecord(part) || remaining <= 0) return []
    if (part.type === "input_image") {
      const estimate = Math.max(1, estimateInput(part))
      if (estimate > remaining) return []
      remaining -= estimate
      return [part]
    }
    if (part.type !== "input_text" || typeof part.text !== "string") return []
    const chars = Math.min(part.text.length, remaining * 4)
    const text = part.text.slice(0, chars)
    remaining = Math.max(0, remaining - Token.estimate(text))
    return text ? [{ ...part, text }] : []
  })
  return content.length > 0 ? { ...item, content } : undefined
}

function isCompactionItem(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (value.type === "compaction" || value.type === "context_compaction" || value.type === "compaction_summary")
  )
}

class RemoteCompactionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export * as OpenCodezResponsesCompact from "./responses-compact"
