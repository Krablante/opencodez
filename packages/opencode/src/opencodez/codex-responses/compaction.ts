import { SessionV1 } from "@opencode-ai/core/v1/session"

export const HEADER = "x-opencodez-responses-compaction-handoff"
export const METADATA_KEY = "opencodez.responses.compaction"
export const TURN_SETTINGS_METADATA_KEY = "opencodez.responses.turn-settings"
export const CONTINUE_MARKER = "__OPENCODEZ_REMOTE_COMPACTION_CONTINUE__"

type Context = {
  items: unknown[]
  windowID?: string
  modelID?: string
  accountKey?: string
  compHash?: string
}

type Handoff = Context & { expiresAt: number }

const HANDOFF_TTL = 60_000
const HANDOFF_LIMIT = 128
const TURN_SETTINGS_LIMIT = 32
const handoffs = new Map<string, Handoff>()

export type TurnSettings = {
  turnID: string
  model: {
    providerID: string
    modelID: string
    apiModelID?: string
  }
  compHash?: string
}

export function turnSettings(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[TURN_SETTINGS_METADATA_KEY]
  if (!Array.isArray(value)) return [] as TurnSettings[]
  return value.filter(isTurnSettings).slice(-TURN_SETTINGS_LIMIT)
}

export function withTurnSettings(
  metadata: Record<string, unknown> | undefined,
  input: TurnSettings,
): Record<string, unknown> {
  const current = turnSettings(metadata)
  const existing = current.find((item) => item.turnID === input.turnID)
  if (
    existing &&
    existing.model.providerID === input.model.providerID &&
    existing.model.modelID === input.model.modelID &&
    existing.model.apiModelID === input.model.apiModelID &&
    existing.compHash === input.compHash
  )
    return metadata ?? {}
  return {
    ...metadata,
    [TURN_SETTINGS_METADATA_KEY]: [...current.filter((item) => item.turnID !== input.turnID), input].slice(
      -TURN_SETTINGS_LIMIT,
    ),
  }
}

export function latest(messages: readonly SessionV1.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.info.role !== "user") continue
    const part = message.parts.find((item) => item.type === "compaction" && item.remote?.providerID === "openai")
    if (part?.type !== "compaction" || !part.remote) continue
    return {
      index,
      messageID: message.info.id,
      windowID: message.info.id,
      items: part.remote.items,
      modelID: part.remote.model_id,
      accountKey: part.remote.account_key,
      compHash: part.remote.comp_hash,
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
      windowID: context.windowID,
      modelID: context.modelID,
      accountKey: context.accountKey,
      compHash: context.compHash,
    } satisfies Context,
  }
}

export function handoff(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[METADATA_KEY]
  if (value === undefined) return undefined
  if (!isContext(value)) throw new Error("This session's OpenAI compacted state is malformed")
  pruneHandoffs()
  while (handoffs.size >= HANDOFF_LIMIT) {
    const oldest = handoffs.keys().next().value
    if (!oldest) break
    handoffs.delete(oldest)
  }
  const id = crypto.randomUUID()
  handoffs.set(id, { ...value, expiresAt: Date.now() + HANDOFF_TTL })
  return id
}

export function has(metadata: Record<string, unknown> | undefined) {
  return metadata?.[METADATA_KEY] !== undefined
}

export function windowID(metadata: Record<string, unknown> | undefined, fallback: string) {
  const context = metadata?.[METADATA_KEY]
  return isContext(context) ? (context.windowID ?? fallback) : fallback
}

export function consume(id: string) {
  const context = handoffs.get(id)
  handoffs.delete(id)
  if (!context || context.expiresAt <= Date.now()) throw new Error("Remote compaction request handoff expired")
  const { expiresAt: _, ...value } = context
  return value
}

function pruneHandoffs() {
  const now = Date.now()
  for (const [id, value] of handoffs) {
    if (value.expiresAt > now) continue
    handoffs.delete(id)
  }
}

export function compatibilityError(
  metadata: Record<string, unknown> | undefined,
  input: { modelID: string; accountKey?: string; compHash?: string; allowCompHashMismatch?: boolean },
): string | undefined {
  const context = metadata?.[METADATA_KEY]
  if (context === undefined) return undefined
  if (!isContext(context)) return "This session's OpenAI compacted state is malformed"
  if (!context.accountKey || !input.accountKey) {
    return "This session's OpenAI compacted state cannot be continued without a verified ChatGPT account identity"
  }
  if (
    !input.allowCompHashMismatch &&
    context.modelID &&
    context.modelID !== input.modelID &&
    (!context.compHash || !input.compHash || context.compHash !== input.compHash)
  ) {
    return `This session's OpenAI compacted state belongs to model ${context.modelID}; continue with that base model or start a new session before switching`
  }
  if (context.accountKey && context.accountKey !== input.accountKey) {
    return "This session's OpenAI compacted state belongs to a different ChatGPT account"
  }
  if (!input.allowCompHashMismatch && input.compHash && context.compHash !== input.compHash) {
    return "This session's OpenAI compacted state belongs to an older backend snapshot and must be compacted again before continuing"
  }
  return undefined
}

export function repeatedOverflow(messages: readonly SessionV1.WithParts[], turnID: string) {
  return messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "compaction" &&
        part.auto &&
        part.phase === "pre-turn" &&
        part.overflow === true &&
        part.remote?.providerID === "openai" &&
        part.replay_id === turnID,
    ),
  )
}

export function isOpaqueItem(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    (value.type === "compaction" || value.type === "compaction_summary") &&
    "encrypted_content" in value &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  )
}

function isContext(value: unknown): value is Context {
  if (!value || typeof value !== "object") return false
  if (!("items" in value) || !Array.isArray(value.items)) return false
  if (value.items.filter(isOpaqueItem).length !== 1) return false
  if (
    value.items.some(
      (item) =>
        !isOpaqueItem(item) &&
        (!item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          !("type" in item) ||
          item.type !== "message" ||
          !("role" in item) ||
          item.role !== "user"),
    )
  )
    return false
  if ("modelID" in value && value.modelID !== undefined && typeof value.modelID !== "string") return false
  if ("windowID" in value && value.windowID !== undefined && typeof value.windowID !== "string") return false
  if ("accountKey" in value && value.accountKey !== undefined && typeof value.accountKey !== "string") return false
  return !("compHash" in value) || value.compHash === undefined || typeof value.compHash === "string"
}

function isTurnSettings(value: unknown): value is TurnSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("turnID" in value) || typeof value.turnID !== "string") return false
  if (!("model" in value) || !value.model || typeof value.model !== "object" || Array.isArray(value.model)) return false
  if (!("providerID" in value.model) || typeof value.model.providerID !== "string") return false
  if (!("modelID" in value.model) || typeof value.model.modelID !== "string") return false
  if ("apiModelID" in value.model && value.model.apiModelID !== undefined && typeof value.model.apiModelID !== "string")
    return false
  return !("compHash" in value) || value.compHash === undefined || typeof value.compHash === "string"
}

export * as CodexResponsesCompaction from "./compaction"
