import os from "node:os"
import { isRecord } from "@/util/record"
import { CodexResponsesAttempt } from "./attempt"

export const INSTALLATION_ID_HEADER = "x-codex-installation-id"
export const WINDOW_ID_HEADER = "x-codex-window-id"
export const TURN_METADATA_HEADER = "x-codex-turn-metadata"
export const TURN_STATE_HEADER = "x-codex-turn-state"
export const INTERNAL_WINDOW_ID_HEADER = "x-opencodez-window-id"
export const INTERNAL_COMPACTION_PHASE_HEADER = "x-opencodez-compaction-phase"
export const INTERNAL_COMPACTION_TRIGGER_HEADER = "x-opencodez-compaction-trigger"
export const INTERNAL_COMPACTION_REASON_HEADER = "x-opencodez-compaction-reason"

const installationID = (() => {
  const digest = new Bun.CryptoHasher("sha256").update(`${os.hostname()}\0${os.homedir()}\0opencodez`).digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
})()

export function accountIdentity(accountID: string | undefined, accessToken?: string) {
  if (accountID) return accountID
  const payload = accessToken?.split(".")[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString())
    return isRecord(claims) && typeof claims.sub === "string" ? claims.sub : undefined
  } catch {
    return undefined
  }
}

export function accountKey(accountID: string | undefined, accessToken?: string) {
  const identity = accountIdentity(accountID, accessToken)
  if (!identity) return undefined
  return new Bun.CryptoHasher("sha256").update(identity).digest("hex")
}

export function enrich(body: Record<string, unknown>, headers: Headers) {
  const sessionID = headers.get("x-session-affinity") ?? headers.get("session-id")
  if (!sessionID) return body
  const turnID = headers.get("x-opencodez-turn-id") ?? undefined
  const windowID = headers.get(INTERNAL_WINDOW_ID_HEADER) ?? sessionID
  const requestKind = headers.get(CodexResponsesAttempt.REQUEST_KIND_HEADER) === "compaction" ? "compaction" : "turn"
  const snapshot: Record<string, unknown> = {
    installation_id: installationID,
    session_id: sessionID,
    thread_id: sessionID,
    ...(turnID ? { turn_id: turnID } : {}),
    window_id: windowID,
    request_kind: requestKind,
    ...(requestKind === "compaction"
      ? {
          compaction: {
            trigger: headers.get(INTERNAL_COMPACTION_TRIGGER_HEADER) === "manual" ? "manual" : "auto",
            reason: headers.get(INTERNAL_COMPACTION_REASON_HEADER) ?? "context_limit",
            implementation: "responses_compaction_v2",
            phase: headers.get(INTERNAL_COMPACTION_PHASE_HEADER) ?? "standalone_turn",
            strategy: "memento",
          },
        }
      : {}),
  }
  const turnMetadata = JSON.stringify(snapshot)
  headers.set(INSTALLATION_ID_HEADER, installationID)
  headers.set(WINDOW_ID_HEADER, windowID)
  headers.set(TURN_METADATA_HEADER, turnMetadata)
  return {
    ...body,
    client_metadata: {
      ...(isRecord(body.client_metadata) ? body.client_metadata : {}),
      [INSTALLATION_ID_HEADER]: installationID,
      session_id: sessionID,
      thread_id: sessionID,
      [WINDOW_ID_HEADER]: windowID,
      ...(turnID ? { turn_id: turnID } : {}),
      [TURN_METADATA_HEADER]: turnMetadata,
    },
  }
}

export function headerValue(value: Record<string, unknown>, name: string) {
  if (value.type !== "response.metadata" || !isRecord(value.headers)) return undefined
  const item = Object.entries(value.headers).find(([key]) => key.toLowerCase() === name)
  return typeof item?.[1] === "string" && item[1] ? item[1] : undefined
}

export const internalHeaders = [
  INTERNAL_WINDOW_ID_HEADER,
  INTERNAL_COMPACTION_PHASE_HEADER,
  INTERNAL_COMPACTION_TRIGGER_HEADER,
  INTERNAL_COMPACTION_REASON_HEADER,
]

export * as CodexResponsesProtocol from "./protocol"
