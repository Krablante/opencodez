import { SessionV1 } from "@opencode-ai/core/v1/session"

export const HEADER = "x-opencodez-responses-compaction-handoff"
export const METADATA_KEY = "opencodez.responses.compaction"
export const CONTINUE_MARKER = "__OPENCODEZ_REMOTE_COMPACTION_CONTINUE__"

type Context = {
  items: unknown[]
  modelID?: string
  accountKey?: string
  compHash?: string
}

type Handoff = Context & { expiresAt: number }

const HANDOFF_TTL = 60_000
const HANDOFF_LIMIT = 128
const handoffs = new Map<string, Handoff>()

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
      modelID: context.modelID,
      accountKey: context.accountKey,
      compHash: context.compHash,
    } satisfies Context,
  }
}

export function handoff(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[METADATA_KEY]
  if (!isContext(value)) return undefined
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
  return isContext(metadata?.[METADATA_KEY])
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
  input: { modelID: string; accountKey?: string; compHash?: string; allowCompHashMismatch?: boolean },
): string | undefined {
  const context = metadata?.[METADATA_KEY]
  if (!isContext(context)) return undefined
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

function isContext(value: unknown): value is Context {
  if (!value || typeof value !== "object") return false
  if (!("items" in value) || !Array.isArray(value.items)) return false
  if ("modelID" in value && value.modelID !== undefined && typeof value.modelID !== "string") return false
  if ("accountKey" in value && value.accountKey !== undefined && typeof value.accountKey !== "string") return false
  return !("compHash" in value) || value.compHash === undefined || typeof value.compHash === "string"
}

export * as OpenCodezResponsesCompaction from "./responses-compaction"
