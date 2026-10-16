import { isRecord } from "@/util/record"
import type { PartID } from "@/session/schema"

export type RequestKind = "sampling" | "compaction"

export const REQUEST_KIND_HEADER = "x-opencodez-responses-request-kind"
export const SESSION_POOL_LIMIT = 256

// Transport metadata is shared by SDK and native Responses. Session policy is
// applied only after the request has been identified as Codex OAuth.
export function outcome(metadata: unknown) {
  const openai = isRecord(metadata) && isRecord(metadata.openai) ? metadata.openai : undefined
  const reason = typeof openai?.incompleteReason === "string" ? openai.incompleteReason : undefined
  return {
    error: reason !== undefined && reason !== "interrupted" ? new IncompleteResponseError(reason) : undefined,
    continue: reason === "interrupted" || openai?.endTurn === false,
  }
}

export class IncompleteResponseError extends Error {
  constructor(
    readonly reason: string,
    readonly usage?: Record<string, unknown>,
  ) {
    super(
      reason === "max_output_tokens"
        ? "OpenAI response reached its output token limit. The partial response was preserved."
        : reason === "content_filter"
          ? "OpenAI response was stopped by the content filter. The partial response was preserved."
          : "OpenAI returned an incomplete response. The partial response was preserved.",
    )
    this.name = "IncompleteResponseError"
  }
}

export function incompleteError(cause: unknown): IncompleteResponseError | undefined {
  const seen = new Set<unknown>()
  for (let error = cause; error instanceof Error && !seen.has(error); error = error.cause) {
    if (error instanceof IncompleteResponseError) return error
    seen.add(error)
  }
}

export function incompleteEvent(event: Record<string, unknown>) {
  if (event.type !== "response.incomplete") return undefined
  const response = isRecord(event.response) ? event.response : undefined
  const details = isRecord(response?.incomplete_details) ? response.incomplete_details : undefined
  return new IncompleteResponseError(
    typeof details?.reason === "string" ? details.reason : "unknown",
    isRecord(response?.usage) ? response.usage : undefined,
  )
}

export function completedEvent(event: Record<string, unknown>) {
  return (
    event.type === "response.completed" ||
    event.type === "response.done" ||
    incompleteEvent(event)?.reason === "interrupted"
  )
}

export type Rollback = {
  readonly partIDs: readonly PartID[]
  readonly durableOutput: boolean
  readonly modelVisible: boolean
}

export function streamRetryLimit(kind: RequestKind) {
  return kind === "compaction" ? 2 : 5
}

export function requestAttemptLimit(kind: RequestKind) {
  return (streamRetryLimit(kind) + 1) * 2
}

export function requestRetryLimit(kind: RequestKind) {
  return requestAttemptLimit(kind) - 1
}

export function requestKind(headers: Record<string, string>): RequestKind {
  return headers[REQUEST_KIND_HEADER] === "compaction" ? "compaction" : "sampling"
}

export function retryableEvent(event: Record<string, unknown>) {
  const response = isRecord(event.response) ? event.response : undefined
  const error = isRecord(event.error) ? event.error : isRecord(response?.error) ? response.error : undefined
  const status = [event.status, error?.status, error?.status_code].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  )
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) return true
  const code = [error?.code, error?.type, response?.status]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
  return ["server_error", "overload", "rate_limit", "timeout", "unavailable", "connection"].some((value) =>
    code.includes(value),
  )
}

export function create() {
  let enabled = false
  let irreversible = false
  let modelVisible = false
  let durableOutput = false
  const partIDs = new Set<PartID>()

  function begin(input: { durableOutput: boolean }) {
    irreversible = false
    modelVisible = false
    durableOutput = input.durableOutput
    partIDs.clear()
  }

  function prepared(input: { codexResponses: boolean }) {
    enabled = input.codexResponses
  }

  function track(partID: PartID) {
    if (!enabled) return
    partIDs.add(partID)
  }

  function markModelVisible() {
    if (!enabled) return
    modelVisible = true
  }

  function markIrreversible() {
    if (!enabled) return
    irreversible = true
  }

  function canRetry() {
    return enabled ? !irreversible : true
  }

  function canResumeFromHistory() {
    return enabled && irreversible
  }

  function active() {
    return enabled
  }

  function retryLimit() {
    return enabled ? requestAttemptLimit("sampling") : undefined
  }

  function rollback(): Rollback | undefined {
    if (!enabled || irreversible) return undefined
    const result = {
      partIDs: [...partIDs].reverse(),
      durableOutput,
      modelVisible,
    } satisfies Rollback
    partIDs.clear()
    modelVisible = false
    return result
  }

  function commit() {
    partIDs.clear()
    modelVisible = false
  }

  return {
    begin,
    prepared,
    track,
    markModelVisible,
    markIrreversible,
    canRetry,
    canResumeFromHistory,
    active,
    retryLimit,
    rollback,
    commit,
  }
}

export * as CodexResponsesAttempt from "./attempt"
