import { isRecord } from "@/util/record"
import type { PartID } from "@/session/schema"

export type RequestKind = "sampling" | "compaction"

export const REQUEST_KIND_HEADER = "x-opencodez-responses-request-kind"
export const SESSION_POOL_LIMIT = 256

export type Rollback = {
  readonly partIDs: readonly PartID[]
  readonly durableOutput: boolean
  readonly modelVisible: boolean
}

export function streamRetryLimit(kind: RequestKind) {
  return kind === "compaction" ? 2 : 5
}

export function requestRetryLimit(kind: RequestKind) {
  return streamRetryLimit(kind) * 2 + 1
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

  function canRetry(input: { durableOutput: boolean }) {
    return enabled ? !irreversible : !input.durableOutput
  }

  function canResumeFromHistory() {
    return enabled && irreversible
  }

  function retryLimit() {
    return enabled ? requestRetryLimit("sampling") : undefined
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
    retryLimit,
    rollback,
    commit,
  }
}

export * as CodexResponsesAttempt from "./attempt"
