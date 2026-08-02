import { isRecord } from "@/util/record"

export type RequestKind = "sampling" | "compaction"

export const REQUEST_KIND_HEADER = "x-opencodez-responses-request-kind"
export const SESSION_POOL_LIMIT = 256

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

export * as OpenCodezResponsesPolicy from "./responses-policy"
