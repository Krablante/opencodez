import WebSocket from "ws"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { Continuation } from "./continuation"
import { OpenAIWebSocket } from "@/plugin/openai/ws"
import { CodexResponsesAttempt } from "./attempt"
import { CodexResponsesProtocol } from "./protocol"

export type Mode = "legacy" | "codex"

export const TITLE_HEADER = "x-opencode-title"
export const TURN_ID_HEADER = "x-opencodez-turn-id"
export const ACCOUNT_AFFINITY_HEADER = "x-opencodez-account-affinity"
export const TURN_STATE_HEADER = "x-codex-turn-state"
export const TURN_PROFILE_HEADER = "x-opencodez-codex-turn-profile"
export const TURN_ACCOUNT_HEADER = "x-opencodez-codex-turn-account"
export const REASONING_INCLUDED_HEADER = "x-reasoning-included"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
  wire?: Mode
  onModelsEtag?: (etag: string, accountKey: string | undefined) => void
}

interface PoolEntry {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  fallbackUntil?: number
  streamFailures: number
  continuation: Continuation
  turnID?: string
  turnState?: string
  reasoningIncluded?: boolean
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const OPAQUE_FALLBACK_COOLDOWN = 60_000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? CodexResponsesAttempt.streamRetryLimit("sampling")
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalHeaders(init)
    const requestKind = CodexResponsesAttempt.requestKind(internalHeaders)
    const requestStreamRetries =
      requestKind === "compaction" ? CodexResponsesAttempt.streamRetryLimit("compaction") : streamRetries

    if (init?.method !== "POST" || !new URL(url).pathname.endsWith("/responses")) {
      return httpFetch(input, httpInit)
    }

    const body = (() => {
      try {
        if (typeof init?.body !== "string") return undefined
        const parsed = JSON.parse(init.body)
        return typeof parsed === "object" && parsed !== null ? parsed : undefined
      } catch {
        return undefined
      }
    })()
    if (!body?.stream) return httpFetch(input, httpInit)
    if (internalHeaders[TITLE_HEADER] === "true") {
      return httpFetch(input, httpInit)
    }

    const sessionID = internalHeaders["x-session-affinity"] ?? internalHeaders["session-id"]
    if (!sessionID) {
      return httpFetch(input, httpInit)
    }
    if (options?.wire === "codex" && !internalHeaders[ACCOUNT_AFFINITY_HEADER]) {
      return httpFetch(input, httpInit)
    }
    // ChatGPT response and reasoning IDs are account-scoped. A login change
    // must start a fresh continuation even when the local session stays open.
    const key = `${sessionID}:conversation:${accountAffinity(internalHeaders)}`

    const entry = pool.get(key) ?? {
      lastUsedAt: Date.now(),
      busy: false,
      fallback: false,
      streamFailures: 0,
      continuation: new Continuation(),
    }
    pool.set(key, entry)
    trimPool()
    const turnID = internalHeaders[TURN_ID_HEADER]

    if (turnID !== entry.turnID) {
      // Codex gives each user turn fresh sticky routing while retaining a
      // compatible previous response on the longer-lived WebSocket session.
      entry.turnID = turnID
      entry.turnState = undefined
    }

    if (entry.fallback || (entry.fallbackUntil ?? 0) > Date.now()) {
      return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
    }
    entry.fallbackUntil = undefined
    if (entry.busy) {
      entry.continuation.reset()
      return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        websocketHeaders(
          OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
          sessionID,
          entry.turnState,
          options?.wire,
        ),
        connectTimeout,
        maxConnectionAge,
        init?.signal,
        (headers) =>
          captureUpgradeHeaders(
            entry,
            turnID,
            headers,
            internalHeaders[ACCOUNT_AFFINITY_HEADER],
            options?.onModelsEtag,
          ),
      )
      let resolveFirstEvent: (event: boolean | OpenAIWebSocket.WrappedError) => void = () => {}
      let rejectFirstEvent: (error: Error) => void = () => {}
      const firstEvent = new Promise<boolean | OpenAIWebSocket.WrappedError>((resolve, reject) => {
        resolveFirstEvent = resolve
        rejectFirstEvent = reject
      })
      const prepared = options?.wire === "codex" ? entry.continuation.prepare(body) : undefined
      let transaction = options?.wire === "codex" ? entry.continuation.transaction(body) : undefined
      const requestBody = withTurnState(prepared ?? body, entry.turnState)
      let recoveredPreviousResponse = false
      let response: Response
      response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body: requestBody,
        idleTimeout,
        signal: init?.signal ?? undefined,
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onEvent: (event) => {
          captureModelsEtag(event, internalHeaders[ACCOUNT_AFFINITY_HEADER], options?.onModelsEtag)
          captureEventTurnState(entry, turnID, event)
          if (CodexResponsesProtocol.headerValue(event, REASONING_INCLUDED_HEADER) !== undefined) {
            entry.reasoningIncluded = true
            response.headers.set(REASONING_INCLUDED_HEADER, "true")
          }
          transaction?.event(event)
        },
        onComplete: (event) => transaction?.complete(event),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          if (event.type === "response.completed" || event.type === "response.done") {
            entry.streamFailures = 0
            return
          }
          transaction?.fail()
          if (!entry.fallback && CodexResponsesAttempt.retryableEvent(event)) {
            recordStreamFailure(entry, requestStreamRetries)
          }
          invalidate(entry)
        },
        onConnectionInvalid: () => {
          transaction?.fail()
          entry.busy = false
          entry.lastUsedAt = Date.now()
          if (!entry.fallback) recordStreamFailure(entry, requestStreamRetries)
          invalidate(entry)
          resolveFirstEvent(false)
        },
        onAbort: (error) => {
          transaction?.fail()
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          invalidate(entry)
          rejectFirstEvent(error)
        },
        onRetryableTerminal: async (event) => {
          if (
            options?.wire === "codex" &&
            !recoveredPreviousResponse &&
            typeof prepared?.previous_response_id === "string" &&
            errorCode(event) === PREVIOUS_RESPONSE_NOT_FOUND_CODE
          ) {
            recoveredPreviousResponse = true
            transaction?.fail()
            invalidate(entry)
            entry.socket = await socket(
              entry,
              options?.url ?? url,
              websocketHeaders(
                OpenAIWebSocket.normalizeHeaders(httpInit?.headers),
                sessionID,
                entry.turnState,
                options?.wire,
              ),
              connectTimeout,
              maxConnectionAge,
              init?.signal,
              (headers) =>
                captureUpgradeHeaders(
                  entry,
                  turnID,
                  headers,
                  internalHeaders[ACCOUNT_AFFINITY_HEADER],
                  options?.onModelsEtag,
                ),
            )
            transaction = entry.continuation.transaction(body)
            return { socket: entry.socket, body: withTurnState(body, entry.turnState) }
          }
          const error = connectionLimitError(event)
          if (!error) return undefined
          throw error
        },
      })
      if (entry.reasoningIncluded) response.headers.set(REASONING_INCLUDED_HEADER, "true")
      const first = await firstEvent
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
        if (first.status === 426) {
          entry.fallback = true
          return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
        }
        return new Response(first.body, {
          status: first.status,
          headers: { "content-type": "application/json", ...first.headers },
        })
      }
      return response
    } catch (error) {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      if (OpenAIWebSocket.isAbortError(error)) {
        entry.streamFailures = 0
        invalidate(entry)
        throw error
      }

      const upgrade = OpenAIWebSocket.upgradeResponse(error)
      if (upgrade?.status === 426) {
        entry.fallback = true
        invalidate(entry)
        return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
      }
      if (upgrade) {
        invalidate(entry)
        return new Response(upgrade.body, { status: upgrade.status, headers: upgrade.headers })
      }
      // Bun exposes non-101 handshakes as one opaque error. Use HTTP immediately,
      // but only cool down WebSocket attempts briefly because the rejection may
      // have been a transient auth or server response rather than a durable 426.
      if (OpenAIWebSocket.isOpaqueUpgradeRejection(error)) {
        entry.fallbackUntil = Date.now() + OPAQUE_FALLBACK_COOLDOWN
        invalidate(entry)
        return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
      }

      recordStreamFailure(entry, requestStreamRetries)
      invalidate(entry)
      return failedResponse(
        new ProviderError.ResponseStreamError(error instanceof Error ? error.message : String(error), {
          cause: error,
        }),
      )
    }
  }

  function recordStreamFailure(entry: PoolEntry, retries: number) {
    entry.streamFailures++
    // Codex counts retries after the initial failed WebSocket attempt.
    if (entry.streamFailures > retries) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy) continue
      if (now - entry.lastUsedAt < idleTimeout) continue
      invalidate(entry)
      if (!entry.fallback) pool.delete(key)
    }
    trimPool()
  }

  function trimPool() {
    if (pool.size <= CodexResponsesAttempt.SESSION_POOL_LIMIT) return
    const candidates = [...pool.entries()]
      .filter(([, entry]) => !entry.busy)
      .toSorted(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
    for (const [key, entry] of candidates) {
      if (pool.size <= CodexResponsesAttempt.SESSION_POOL_LIMIT) break
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    clearInterval(pruneTimer)
    for (const entry of pool.values()) invalidate(entry)
    pool.clear()
  }

  function remove(sessionID: string) {
    const prefix = `${sessionID}:conversation:`
    for (const [key, entry] of pool) {
      if (!key.startsWith(prefix)) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  return Object.assign(websocketFetch, { close, remove })
}

function connectionLimitError(event: Record<string, unknown>): Error | undefined {
  if (errorCode(event) !== CONNECTION_LIMIT_REACHED_CODE) return undefined
  const error = isRecord(event.error) ? event.error : {}
  return new Error(typeof error.message === "string" ? error.message : CONNECTION_LIMIT_REACHED_CODE)
}

function errorCode(event: Record<string, unknown>): string | undefined {
  if (event.type !== "error" || !isRecord(event.error) || typeof event.error.code !== "string") return undefined
  return event.error.code
}

function captureEventTurnState(entry: PoolEntry, turnID: string | undefined, event: Record<string, unknown>) {
  if (entry.turnState || entry.turnID !== turnID) return
  entry.turnState = CodexResponsesProtocol.headerValue(event, TURN_STATE_HEADER)
}

function captureModelsEtag(
  event: Record<string, unknown>,
  accountKey: string | undefined,
  observe: ((etag: string, accountKey: string | undefined) => void) | undefined,
) {
  if (!observe) return
  const etag = CodexResponsesProtocol.headerValue(event, "x-models-etag")
  if (etag) observe(etag, accountKey)
}

function captureHeaderTurnState(entry: PoolEntry, turnID: string | undefined, headers: Record<string, string>) {
  if (entry.turnState || entry.turnID !== turnID) return
  const state = headers[TURN_STATE_HEADER]
  if (state) entry.turnState = state
}

function captureUpgradeHeaders(
  entry: PoolEntry,
  turnID: string | undefined,
  headers: Record<string, string>,
  accountKey: string | undefined,
  observe: ((etag: string, accountKey: string | undefined) => void) | undefined,
) {
  captureHeaderTurnState(entry, turnID, headers)
  entry.reasoningIncluded = REASONING_INCLUDED_HEADER in headers
  const etag = headers["x-models-etag"]
  if (etag) observe?.(etag, accountKey)
}

async function fallbackFetch(
  fetcher: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  entry: PoolEntry,
  turnID: string | undefined,
) {
  entry.lastUsedAt = Date.now()
  const response = await fetcher(input, {
    ...init,
    headers: withTurnStateHeader(OpenAIWebSocket.normalizeHeaders(init?.headers), entry.turnState),
  })
  captureHeaderTurnState(entry, turnID, OpenAIWebSocket.normalizeHeaders(response.headers))
  return response
}

function withTurnState(body: Record<string, unknown>, turnState: string | undefined) {
  if (!turnState) return body
  return {
    ...body,
    client_metadata: {
      ...(isRecord(body.client_metadata) ? body.client_metadata : {}),
      [TURN_STATE_HEADER]: turnState,
    },
  }
}

function withTurnStateHeader(headers: Record<string, string>, turnState: string | undefined) {
  return turnState ? { ...headers, [TURN_STATE_HEADER]: turnState } : headers
}

function websocketHeaders(
  headers: Record<string, string>,
  sessionID: string,
  turnState: string | undefined,
  wire?: Mode,
) {
  const result = withTurnStateHeader(headers, turnState)
  if (wire !== "codex" || result["x-client-request-id"]) return result
  return { ...result, "x-client-request-id": sessionID }
}

function accountAffinity(headers: Record<string, string>) {
  return headers[ACCOUNT_AFFINITY_HEADER] ?? ""
}

function failedResponse(error: ProviderError.ResponseStreamError) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function socket(
  entry: PoolEntry,
  url: string,
  headers: Record<string, string>,
  connectTimeout: number,
  maxConnectionAge: number,
  signal?: AbortSignal | null,
  onUpgrade?: (headers: Record<string, string>) => void,
) {
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAge
  ) {
    return entry.socket
  }

  invalidate(entry)
  const next = await OpenAIWebSocket.connectResponsesWebSocket({
    url: OpenAIWebSocket.toWebSocketUrl(url),
    headers,
    timeout: connectTimeout,
    signal: signal ?? undefined,
    onUpgrade,
  })
  entry.connectedAt = Date.now()
  return next
}

function invalidate(entry: PoolEntry) {
  entry.continuation.reset()
  if (entry.socket) {
    entry.socket.on("error", () => {})
    entry.socket.terminate()
    entry.socket = undefined
  }
  entry.connectedAt = undefined
  entry.reasoningIncluded = undefined
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    headers.delete(TURN_ID_HEADER)
    headers.delete(ACCOUNT_AFFINITY_HEADER)
    headers.delete(TURN_PROFILE_HEADER)
    headers.delete(TURN_ACCOUNT_HEADER)
    headers.delete(CodexResponsesAttempt.REQUEST_KIND_HEADER)
    CodexResponsesProtocol.internalHeaders.forEach((key) => headers.delete(key))
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return {
      ...init,
      headers: init.headers.filter((item) => !isInternalHeader(item[0])),
    }
  }

  return {
    ...init,
    headers: Object.fromEntries(Object.entries(init.headers).filter(([key]) => !isInternalHeader(key))),
  }
}

function isInternalHeader(value: string) {
  const key = value.toLowerCase()
  return (
    key === TITLE_HEADER ||
    key === TURN_ID_HEADER ||
    key === ACCOUNT_AFFINITY_HEADER ||
    key === TURN_PROFILE_HEADER ||
    key === TURN_ACCOUNT_HEADER ||
    key === CodexResponsesAttempt.REQUEST_KIND_HEADER ||
    CodexResponsesProtocol.internalHeaders.includes(key)
  )
}

export * as CodexResponsesTransport from "./transport"
