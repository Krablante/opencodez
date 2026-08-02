import WebSocket from "ws"
import { ProviderError } from "@/provider/error"
import { isRecord } from "@/util/record"
import { Continuation, type Mode } from "./responses-wire"
import { OpenAIWebSocket } from "./ws"
import { OpenCodezResponsesPolicy } from "@/opencodez/responses-policy"

export const TITLE_HEADER = "x-opencode-title"
export const TURN_ID_HEADER = "x-opencodez-turn-id"
export const ACCOUNT_AFFINITY_HEADER = "x-opencodez-account-affinity"
export const TURN_STATE_HEADER = "x-codex-turn-state"

export interface CreateWebSocketFetchOptions {
  httpFetch?: typeof globalThis.fetch
  url?: string
  connectTimeout?: number
  idleTimeout?: number
  maxConnectionAge?: number
  streamRetries?: number
  wire?: Mode
  onModelsEtag?: (etag: string) => void
}

interface PoolEntry {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
  continuation: Continuation
  turnID?: string
  turnState?: string
}

const DEFAULT_CONNECT_TIMEOUT = 15_000
const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found"

export function createWebSocketFetch(options?: CreateWebSocketFetchOptions) {
  const httpFetch = options?.httpFetch ?? globalThis.fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeout = options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT
  const idleTimeout = options?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
  const maxConnectionAge = options?.maxConnectionAge ?? DEFAULT_MAX_CONNECTION_AGE
  const streamRetries = options?.streamRetries ?? OpenCodezResponsesPolicy.streamRetryLimit("sampling")
  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeout, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer && typeof pruneTimer.unref === "function") {
    pruneTimer.unref()
  }

  async function websocketFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url
    const internalHeaders = OpenAIWebSocket.normalizeHeaders(init?.headers)
    const httpInit = withoutInternalHeaders(init)
    const requestKind = OpenCodezResponsesPolicy.requestKind(internalHeaders)
    const requestStreamRetries =
      requestKind === "compaction" ? OpenCodezResponsesPolicy.streamRetryLimit("compaction") : streamRetries

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

    if (entry.fallback) {
      if (turnID !== entry.turnID) {
        entry.turnID = turnID
        entry.turnState = undefined
      }
      return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
    }
    if (entry.busy) {
      entry.continuation.reset()
      if (turnID !== entry.turnID) {
        entry.turnID = turnID
        entry.turnState = undefined
      }
      return fallbackFetch(httpFetch, input, httpInit, entry, turnID)
    }
    if (turnID !== entry.turnID) {
      entry.turnID = turnID
      entry.turnState = undefined
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()
    try {
      entry.socket = await socket(
        entry,
        options?.url ?? url,
        withTurnStateHeader(OpenAIWebSocket.normalizeHeaders(httpInit?.headers), entry.turnState),
        connectTimeout,
        maxConnectionAge,
        init?.signal,
        (headers) => captureHeaderTurnState(entry, turnID, headers),
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
      const response = OpenAIWebSocket.streamResponsesWebSocket({
        socket: entry.socket,
        body: requestBody,
        idleTimeout,
        signal: init?.signal ?? undefined,
        onFirstEvent: (error) => resolveFirstEvent(error ?? true),
        onEvent: (event) => {
          captureModelsEtag(event, options?.onModelsEtag)
          captureEventTurnState(entry, turnID, event)
          transaction?.event(event)
        },
        onComplete: (event) => transaction?.complete(event),
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (event.type !== "response.completed" && event.type !== "response.done") {
            transaction?.fail()
            invalidate(entry)
          }
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
              withTurnStateHeader(OpenAIWebSocket.normalizeHeaders(httpInit?.headers), entry.turnState),
              connectTimeout,
              maxConnectionAge,
              init?.signal,
              (headers) => captureHeaderTurnState(entry, turnID, headers),
            )
            transaction = entry.continuation.transaction(body)
            return { socket: entry.socket, body: withTurnState(body, entry.turnState) }
          }
          const error = connectionLimitError(event)
          if (!error) return undefined
          throw error
        },
      })
      const first = await firstEvent
      if (first !== false) {
        if (first === true || first.status < 200 || first.status > 599) return response
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
    if (pool.size <= OpenCodezResponsesPolicy.SESSION_POOL_LIMIT) return
    const candidates = [...pool.entries()]
      .filter(([, entry]) => !entry.busy)
      .toSorted(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
    for (const [key, entry] of candidates) {
      if (pool.size <= OpenCodezResponsesPolicy.SESSION_POOL_LIMIT) break
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
  if (entry.turnState || entry.turnID !== turnID || event.type !== "response.metadata" || !isRecord(event.headers))
    return
  const state = Object.entries(event.headers).find(([key]) => key.toLowerCase() === TURN_STATE_HEADER)?.[1]
  if (typeof state === "string" && state) entry.turnState = state
}

function captureModelsEtag(event: Record<string, unknown>, observe: ((etag: string) => void) | undefined) {
  if (!observe || event.type !== "response.metadata" || !isRecord(event.headers)) return
  const etag = Object.entries(event.headers).find(([key]) => key.toLowerCase() === "x-models-etag")?.[1]
  if (typeof etag === "string" && etag) observe(etag)
}

function captureHeaderTurnState(entry: PoolEntry, turnID: string | undefined, headers: Record<string, string>) {
  if (entry.turnState || entry.turnID !== turnID) return
  const state = headers[TURN_STATE_HEADER]
  if (state) entry.turnState = state
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

function accountAffinity(headers: Record<string, string>) {
  return headers[ACCOUNT_AFFINITY_HEADER] ?? headers["chatgpt-account-id"] ?? ""
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
}

export function withoutInternalHeaders<T extends { headers?: HeadersInit }>(init: T | undefined): T | undefined {
  if (!init?.headers) return init
  if (init.headers instanceof Headers) {
    const headers = new Headers(init.headers)
    headers.delete(TITLE_HEADER)
    headers.delete(TURN_ID_HEADER)
    headers.delete(ACCOUNT_AFFINITY_HEADER)
    headers.delete(OpenCodezResponsesPolicy.REQUEST_KIND_HEADER)
    return { ...init, headers }
  }

  if (Array.isArray(init.headers)) {
    return {
      ...init,
      headers: init.headers.filter(
        (item) =>
          item[0].toLowerCase() !== TITLE_HEADER &&
          item[0].toLowerCase() !== TURN_ID_HEADER &&
          item[0].toLowerCase() !== ACCOUNT_AFFINITY_HEADER &&
          item[0].toLowerCase() !== OpenCodezResponsesPolicy.REQUEST_KIND_HEADER,
      ),
    }
  }

  return {
    ...init,
    headers: Object.fromEntries(
      Object.entries(init.headers).filter(
        ([key]) =>
          key.toLowerCase() !== TITLE_HEADER &&
          key.toLowerCase() !== TURN_ID_HEADER &&
          key.toLowerCase() !== ACCOUNT_AFFINITY_HEADER &&
          key.toLowerCase() !== OpenCodezResponsesPolicy.REQUEST_KIND_HEADER,
      ),
    ),
  }
}

export * as OpenAIWebSocketPool from "./ws-pool"
