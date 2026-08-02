import { SessionV1 } from "@opencode-ai/core/v1/session"

export const HEADER = "x-opencodez-responses-compaction"
export const METADATA_KEY = "opencodez.responses.compaction"
export const CONTINUE_MARKER = "__OPENCODEZ_REMOTE_COMPACTION_CONTINUE__"

type Context = {
  items: unknown[]
  modelID?: string
  accountKey?: string
}

const active = new Map<string, Context>()

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
      modelID: part.remote.model_id,
      accountKey: part.remote.account_key,
    }
  }
  return undefined
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
    ...metadata,
    [METADATA_KEY]: {
      items: context.items,
      modelID: context.modelID,
      accountKey: context.accountKey,
    } satisfies Context,
  }
}

export function register(sessionID: string, metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[METADATA_KEY]
  if (!isContext(value)) return false
  active.set(sessionID, value)
  return true
}

export function has(metadata: Record<string, unknown> | undefined) {
  return isContext(metadata?.[METADATA_KEY])
}

export function inject(body: BodyInit | null | undefined, sessionID: string | undefined) {
  if (!sessionID) throw new Error("Remote compaction request is missing a session ID")
  if (typeof body !== "string") throw new Error("Remote compaction request body must be JSON text")
  const context = active.get(sessionID)
  if (!context) throw new Error(`Remote compaction context is unavailable for session ${sessionID}`)
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== "object" || !("input" in parsed) || !Array.isArray(parsed.input)) {
      throw new Error("Remote compaction request input must be an array")
    }
    const firstNonSystem = parsed.input.findIndex((item) => !isSystemMessage(item))
    const split = firstNonSystem === -1 ? parsed.input.length : firstNonSystem
    const system = parsed.input.slice(0, split)
    const tail = parsed.input.slice(split)
    const marker = tail.findIndex(isContinueMarker)
    const input = marker === -1 ? tail : [...tail.slice(0, marker), ...tail.slice(marker + 1)]
    return JSON.stringify({
      ...parsed,
      // Persisted compaction state never owns the current request controls.
      // Keep the current System prefix and place opaque state immediately after it.
      input: [...system, ...context.items.filter((item) => !isSystemMessage(item)), ...input],
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Remote compaction")) throw error
    throw new Error("Remote compaction request body is not valid JSON", { cause: error })
  }
}

function isSystemMessage(value: unknown) {
  return !!value && typeof value === "object" && "role" in value && value.role === "system"
}

function isContinueMarker(value: unknown) {
  if (!value || typeof value !== "object" || !("role" in value) || value.role !== "user") return false
  if (!("content" in value) || !Array.isArray(value.content) || value.content.length !== 1) return false
  const content = value.content[0]
  return (
    !!content &&
    typeof content === "object" &&
    "type" in content &&
    content.type === "input_text" &&
    "text" in content &&
    content.text === CONTINUE_MARKER
  )
}

export function clear(sessionID: string) {
  active.delete(sessionID)
}

export function accountIdentity(accountID: string | undefined, accessToken?: string) {
  if (accountID) return accountID
  const payload = accessToken?.split(".")[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString())
    return claims && typeof claims === "object" && "sub" in claims && typeof claims.sub === "string"
      ? claims.sub
      : undefined
  } catch {
    return undefined
  }
}

export function accountKey(accountID: string | undefined, accessToken?: string) {
  const identity = accountIdentity(accountID, accessToken)
  if (!identity) return undefined
  return new Bun.CryptoHasher("sha256").update(identity).digest("hex")
}

export function compatibilityError(
  metadata: Record<string, unknown> | undefined,
  input: { modelID: string; accountKey?: string },
): string | undefined {
  const context = metadata?.[METADATA_KEY]
  if (!isContext(context)) return undefined
  if (context.modelID && context.modelID !== input.modelID) {
    return `This session's OpenAI compacted state belongs to model ${context.modelID}; continue with that base model or start a new session before switching`
  }
  if (context.accountKey && context.accountKey !== input.accountKey) {
    return "This session's OpenAI compacted state belongs to a different ChatGPT account"
  }
  return undefined
}

export function repeatedOverflow(messages: readonly SessionV1.WithParts[], turnID: string) {
  const current = messages.find(
    (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
      message.info.role === "user" && message.info.id === turnID,
  )
  if (!current) return false
  const marker = messages.findLast((message) => {
    if (message.info.role !== "user" || message.info.id >= current.info.id) return false
    return message.parts.some(
      (part) =>
        part.type === "compaction" &&
        part.auto &&
        part.phase === "pre-turn" &&
        part.overflow === true &&
        part.remote?.providerID === "openai" &&
        part.turn_id !== undefined,
    )
  })
  const part = marker?.parts.find(
    (item): item is SessionV1.CompactionPart =>
      item.type === "compaction" &&
      item.auto &&
      item.phase === "pre-turn" &&
      item.overflow === true &&
      item.remote?.providerID === "openai" &&
      item.turn_id !== undefined,
  )
  if (!part?.turn_id) return false
  const original = messages.find(
    (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
      message.info.role === "user" && message.info.id === part.turn_id,
  )
  if (!original) return false
  return JSON.stringify(comparableParts(original.parts)) === JSON.stringify(comparableParts(current.parts))
}

function comparableParts(parts: readonly SessionV1.Part[]) {
  return parts
    .filter((part) => part.type !== "compaction")
    .map((part) =>
      Object.fromEntries(
        Object.entries(part).filter(([key]) => key !== "id" && key !== "messageID" && key !== "sessionID"),
      ),
    )
}

function isContext(value: unknown): value is Context {
  if (!value || typeof value !== "object") return false
  if (!("items" in value) || !Array.isArray(value.items)) return false
  if ("modelID" in value && value.modelID !== undefined && typeof value.modelID !== "string") return false
  return !("accountKey" in value) || value.accountKey === undefined || typeof value.accountKey === "string"
}

export * as OpenCodezResponsesCompaction from "./responses-compaction"
