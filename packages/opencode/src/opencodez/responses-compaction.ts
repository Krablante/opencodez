import { SessionV1 } from "@opencode-ai/core/v1/session"

export const HEADER = "x-opencodez-responses-compaction"
export const METADATA_KEY = "opencodez.responses.compaction"

type Context = {
  items: unknown[]
}

const active = new Map<string, unknown[]>()

export function latest(messages: readonly SessionV1.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.info.role !== "user") continue
    const part = message.parts.find((item) => item.type === "compaction" && item.remote?.providerID === "openai")
    if (part?.type !== "compaction" || !part.remote) continue
    return {
      index,
      messageID: message.info.id,
      items: part.remote.items,
    }
  }
}

export function tail(messages: readonly SessionV1.WithParts[]) {
  const context = latest(messages)
  if (!context) return { messages: [...messages], items: [] as unknown[] }
  return {
    messages: messages
      .slice(context.index + 1)
      .filter(
        (message) =>
          !(message.info.role === "assistant" && message.info.parentID === context.messageID && message.info.summary),
      ),
    items: context.items,
  }
}

export function withMetadata(metadata: Record<string, unknown> | undefined, messages: readonly SessionV1.WithParts[]) {
  const context = latest(messages)
  if (!context) return metadata
  return {
    ...(metadata ?? {}),
    [METADATA_KEY]: {
      items: context.items,
    } satisfies Context,
  }
}

export function register(sessionID: string, metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[METADATA_KEY]
  if (!isContext(value)) return false
  active.set(sessionID, value.items)
  return true
}

export function has(metadata: Record<string, unknown> | undefined) {
  return isContext(metadata?.[METADATA_KEY])
}

export function inject(body: BodyInit | null | undefined, sessionID: string | undefined) {
  if (!sessionID) throw new Error("Remote compaction request is missing a session ID")
  if (typeof body !== "string") throw new Error("Remote compaction request body must be JSON text")
  const items = active.get(sessionID)
  if (!items) throw new Error(`Remote compaction context is unavailable for session ${sessionID}`)
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (!Array.isArray(parsed.input)) throw new Error("Remote compaction request input must be an array")
    const firstNonSystem = parsed.input.findIndex((item) => !isSystemMessage(item))
    const split = firstNonSystem === -1 ? parsed.input.length : firstNonSystem
    const system = parsed.input.slice(0, split)
    const input = parsed.input.slice(split)
    return JSON.stringify({
      ...parsed,
      // /compact echoes the system item it received, but Codex rejects that
      // stale item when the compacted context is replayed. Keep the current
      // request's system prefix and place compacted state immediately after it.
      input: [...system, ...items.filter((item) => !isSystemMessage(item)), ...input],
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Remote compaction")) throw error
    throw new Error("Remote compaction request body is not valid JSON", { cause: error })
  }
}

function isSystemMessage(value: unknown) {
  return !!value && typeof value === "object" && "role" in value && value.role === "system"
}

export function clear(sessionID: string) {
  active.delete(sessionID)
}

function isContext(value: unknown): value is Context {
  return !!value && typeof value === "object" && Array.isArray((value as Context).items)
}

export * as OpenCodezResponsesCompaction from "./responses-compaction"
