import { Cause, Effect, Schedule } from "effect"
import type { Provider } from "@/provider/provider"
import { LLMNative } from "@/session/llm/native-request"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { ProviderTransform } from "@/provider/transform"
import type { LLMRequestPrep } from "@/session/llm/request"
import { isContextOverflow } from "@opencode-ai/llm"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { CodexResponsesTransport } from "./transport"
import { CodexResponsesAttempt } from "./attempt"
import { CodexResponsesCatalog } from "./catalog"
import { CodexResponsesProtocol } from "./protocol"
import { CodexResponsesCompaction } from "./compaction"

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

function toCompactInput(input: { model: Provider.Model; prepared: LLMRequestPrep.Prepared }) {
  const request = LLMNative.request({
    model: input.model,
    // OAuth sampling already carries this System in options.instructions.
    system: typeof input.prepared.params.options.instructions === "string" ? [] : input.prepared.system,
    messages: ProviderTransform.message(input.prepared.messages, input.model, input.prepared.messageTransformOptions),
    tools: input.prepared.tools,
    toolChoice: input.prepared.toolChoice ?? "auto",
    temperature: input.prepared.params.temperature,
    topP: input.prepared.params.topP,
    topK: input.prepared.params.topK,
    maxOutputTokens: input.prepared.params.maxOutputTokens,
    // Compact input must remain self-contained under ZDR. A streamed V2
    // compaction cannot rehydrate non-persisted reasoning items by rs_* id.
    providerOptions: ProviderTransform.providerOptions(input.model, { ...input.prepared.params.options, store: false }),
    headers: {},
  })
  return OpenAIResponses.protocol.body.from(request)
}

export function compact(input: {
  model: Provider.Model
  provider: Provider.Info
  prepared: LLMRequestPrep.Prepared
  items: unknown[]
  sessionID: string
  accountKey: string
  turnProfile: CodexResponsesCatalog.Profile | undefined
  windowID: string
  turnID?: string
  compaction: {
    trigger: "manual" | "auto"
    reason: "user_requested" | "context_limit" | "comp_hash_changed" | "model_downshift"
    phase: "standalone_turn" | "pre_turn" | "mid_turn"
  }
  preserveActiveToolMedia: boolean
  abort: AbortSignal
}) {
  return Effect.gen(function* () {
    const body = yield* toCompactInput(input)
    if (!Array.isArray(body.input)) throw new Error("OpenAI compact input must be an array")
    const request = compactBody(body, [...input.items.filter((item) => !isSystemMessage(item)), ...body.input])
    // Preparation owns the effective profile, including context overrides and
    // frozen turn settings. Re-resolving here would restore the default window.
    const target = OpenCodezSettings.responsesCompactionPayloadLimit(
      input.model.limit,
      input.turnProfile?.contextWindow,
    )
    yield* Effect.logInfo("prepared remote compaction", {
      model: input.model.api.id,
      phase: input.compaction.phase,
      estimated_tokens: estimateInput(request),
      target,
    })

    const baseURL =
      typeof input.provider.options.baseURL === "string"
        ? input.provider.options.baseURL.replace(/\/$/, "")
        : "https://api.openai.com/v1"
    const fetcher: typeof fetch =
      typeof input.provider.options.fetch === "function" ? input.provider.options.fetch : fetch
    const send = Effect.tryPromise({
      try: (signal) =>
        fetcher(`${baseURL}/responses`, {
          method: "POST",
          headers: {
            // A sampling snapshot may contain an already consumed one-shot
            // handoff. Compact installs active.items directly into its input.
            ...Object.fromEntries(
              Object.entries(input.prepared.headers).filter(
                ([key]) => key.toLowerCase() !== CodexResponsesCompaction.HEADER,
              ),
            ),
            "content-type": "application/json",
            "x-session-affinity": input.sessionID,
            ...(input.turnID ? { [CodexResponsesTransport.TURN_ID_HEADER]: input.turnID } : {}),
            [CodexResponsesAttempt.REQUEST_KIND_HEADER]: "compaction",
            [CodexResponsesProtocol.INTERNAL_WINDOW_ID_HEADER]: input.windowID,
            [CodexResponsesProtocol.INTERNAL_COMPACTION_TRIGGER_HEADER]: input.compaction.trigger,
            [CodexResponsesProtocol.INTERNAL_COMPACTION_REASON_HEADER]: input.compaction.reason,
            [CodexResponsesProtocol.INTERNAL_COMPACTION_PHASE_HEADER]: input.compaction.phase,
            [CodexResponsesTransport.TURN_ACCOUNT_HEADER]: input.accountKey,
            ...(input.turnProfile
              ? {
                  [CodexResponsesTransport.TURN_PROFILE_HEADER]: CodexResponsesCatalog.encodeProfile(input.turnProfile),
                }
              : {}),
          },
          body: JSON.stringify(request),
          signal: AbortSignal.any([signal, input.abort]),
        }).then(async (response) => {
          if (!response.ok) {
            const detail = await response.text().catch(() => "")
            throw new RemoteCompactionError(
              `OpenAI remote compaction failed (${response.status})${detail ? `: ${detail}` : ""}`,
              response.status === 429 || response.status >= 500,
              retryDelay(response),
              undefined,
              contextOverflow(detail),
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
              undefined,
              { cause },
            ),
    }).pipe(
      Effect.retry({
        times: CodexResponsesAttempt.requestRetryLimit("compaction"),
        schedule: Schedule.both(Schedule.identity<RemoteCompactionError>(), Schedule.exponential("500 millis")).pipe(
          Schedule.modifyDelay(([error], duration) =>
            Effect.succeed(
              error instanceof RemoteCompactionError && error.retryDelayMs !== undefined
                ? error.retryDelayMs
                : duration,
            ),
          ),
        ),
        while: (error) => error.retryable && !error.contextOverflow,
      }),
    )
    // Encrypted state is not ordinary prompt text. A coarse local estimate
    // cannot veto a request or justify discarding tool work before OpenAI sees it.
    // Retry a confirmed overflow once with bounded tool outputs, on a fresh full
    // request selected by the normal continuation compatibility check.
    const payload = yield* send.pipe(
      Effect.map((value) => ({ ...value, trimmedOutputs: 0 })),
      Effect.catchIf(
        (error) => error.contextOverflow,
        (error) =>
          Effect.gen(function* () {
            const bounded = trimOutputs(request, target, input.preserveActiveToolMedia)
            if (bounded.rewritten === 0) return yield* Effect.fail(error)
            yield* Effect.logInfo("retrying remote compaction after provider context overflow", {
              model: input.model.api.id,
              trimmed_outputs: bounded.rewritten,
              estimated_tokens: bounded.estimate,
              target,
            })
            return { ...(yield* send), trimmedOutputs: bounded.rewritten }
          }),
      ),
    )
    return {
      items: payload.items,
      trimmedOutputs: payload.trimmedOutputs,
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
    ? body.input.findLastIndex((item) => isRecord(item) && item.role === "user")
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
    // The provider already confirmed overflow, even if this heuristic is low.
    if (rewritten > 0 && estimate <= contextWindow) break
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
  let estimate = estimateText(JSON.stringify(value))
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(visit)
      return
    }
    if (!isRecord(item)) return
    // Tool-result preflight sees the persisted SessionV1 FilePart before the
    // provider lowers it to an input_image. Treat both forms as the same media.
    const imageURL =
      item.type === "input_image" && typeof item.image_url === "string"
        ? item.image_url
        : item.type === "file" &&
            typeof item.mime === "string" &&
            item.mime.startsWith("image/") &&
            typeof item.url === "string"
          ? item.url
          : undefined
    if (imageURL) {
      const payload = inlineImagePayload(imageURL)
      if (payload) {
        estimate =
          Math.max(0, estimate - estimateText(payload)) +
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
  return isRecord(value) && value.role === "system"
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
        CodexResponsesAttempt.retryableEvent(event),
        undefined,
        undefined,
        contextOverflow(error),
      )
    }
    if (event.type === "response.output_item.done" && CodexResponsesCompaction.isOpaqueItem(event.item))
      output.push(event.item)
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
    throw new RemoteCompactionError("OpenAI remote compaction returned invalid event JSON", false, undefined, { cause })
  }
}

function retainUserMessages(input: unknown[]): Record<string, unknown>[] {
  let remaining = RETAINED_MESSAGE_TOKEN_BUDGET
  const retained: Record<string, unknown>[] = []
  for (const item of input.toReversed()) {
    if (!isRecord(item) || item.role !== "user") continue
    if (remaining <= 0) break
    const message = { ...item, type: "message" }
    const estimate = Math.max(1, estimateInput(message))
    if (estimate <= remaining) {
      retained.push(message)
      remaining -= estimate
      continue
    }
    const truncated = truncateMessage(message, remaining)
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
    const text = truncateText(part.text, remaining)
    remaining = Math.max(0, remaining - estimateText(text))
    return text ? [{ ...part, text }] : []
  })
  return content.length > 0 ? { ...item, content } : undefined
}

export function estimateText(value: string) {
  return Math.max(0, Math.ceil(Buffer.byteLength(value, "utf8") / 4))
}

export function canRetryWithCurrentModel(cause: unknown) {
  const seen = new Set<unknown>()
  let current = cause
  while (current && !seen.has(current)) {
    seen.add(current)
    if (current instanceof DOMException && (current.name === "AbortError" || current.name === "TimeoutError"))
      return false
    current = current instanceof Error ? current.cause : undefined
  }
  return true
}

function truncateText(value: string, tokens: number) {
  const maxBytes = tokens * 4
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  let bytes = 0
  let end = 0
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (bytes + width > maxBytes) break
    bytes += width
    end += character.length
  }
  return value.slice(0, end)
}

class RemoteCompactionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryDelayMs?: number,
    options?: ErrorOptions,
    readonly contextOverflow = false,
  ) {
    super(message, options)
  }
}

function contextOverflow(value: unknown) {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  return isContextOverflow(text) || text.includes('"context_window_exceeded"')
}

function retryDelay(response: Response) {
  const value = response.headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export * as CodexResponsesCompact from "./compact"
