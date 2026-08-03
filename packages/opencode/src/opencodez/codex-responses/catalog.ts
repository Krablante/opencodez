import type { Auth } from "@/auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { CodexResponsesProtocol } from "./protocol"

export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite"
export const RESPONSES_LITE_METADATA = "ws_request_header_x_openai_internal_codex_responses_lite"

export type Profile = {
  readonly modelID: string
  readonly contextWindow: number
  readonly autoCompactTokenLimit?: number
  readonly compHash?: string
  readonly responsesLite: boolean
}

export function encodeProfile(profile: Profile) {
  return Buffer.from(JSON.stringify(profile)).toString("base64url")
}

export function decodeProfile(value: string | null | undefined) {
  if (!value) return undefined
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString())
    return isProfile(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

export function isProfile(value: unknown): value is Profile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("modelID" in value) || typeof value.modelID !== "string") return false
  if (!("contextWindow" in value) || typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow))
    return false
  if (
    "autoCompactTokenLimit" in value &&
    value.autoCompactTokenLimit !== undefined &&
    (typeof value.autoCompactTokenLimit !== "number" || !Number.isFinite(value.autoCompactTokenLimit))
  )
    return false
  if ("compHash" in value && value.compHash !== undefined && typeof value.compHash !== "string") return false
  return "responsesLite" in value && typeof value.responsesLite === "boolean"
}

export type Snapshot = {
  readonly profiles: ReadonlyMap<string, Profile>
}

type Catalog = Snapshot & {
  readonly accountKey: string
  readonly etag?: string
  readonly expiresAt: number
}

type RemoteModel = {
  readonly slug: string
  readonly context_window: number
  readonly auto_compact_token_limit?: number | null
  readonly comp_hash?: string | null
  readonly use_responses_lite?: boolean
}

type Model = {
  readonly api: { readonly id: string }
}

const CACHE_TTL = 5 * 60 * 1000
const FAILURE_TTL = 60 * 1000
const CACHE_LIMIT = 8
const FALLBACK_PROFILES: Profile[] = [
  { modelID: "gpt-5.4", contextWindow: 272_000, compHash: "2911", responsesLite: false },
  { modelID: "gpt-5.4-mini", contextWindow: 272_000, compHash: "2911", responsesLite: false },
  { modelID: "gpt-5.5", contextWindow: 272_000, compHash: "2911", responsesLite: false },
  { modelID: "gpt-5.6-luna", contextWindow: 272_000, compHash: "3000", responsesLite: true },
  { modelID: "gpt-5.6-terra", contextWindow: 272_000, compHash: "3000", responsesLite: true },
  { modelID: "gpt-5.6-sol", contextWindow: 272_000, compHash: "3000", responsesLite: true },
]
const FALLBACK = new Map(FALLBACK_PROFILES.map((profile) => [profile.modelID, profile]))

const cache = new Map<string, Catalog>()
const pending = new Map<string, Promise<Catalog>>()

export async function initialize<T extends Record<string, Model>>(
  models: T,
  input: {
    readonly auth: Extract<Auth.Info, { type: "oauth" }>
    readonly endpoint: string
    readonly fetcher?: typeof fetch
  },
) {
  if (!CodexResponsesProtocol.accountKey(input.auth.accountId, input.auth.access)) return models
  await refresh(input)
  return models
}

export function resolve(model: Model, accountKey?: string, snapshot?: Snapshot): Profile | undefined {
  return resolveID(model.api.id, accountKey, snapshot)
}

export function resolveID(modelID: string, accountKey?: string, snapshot?: Snapshot): Profile | undefined {
  const cached = accountKey ? cache.get(accountKey) : undefined
  if (cached && accountKey) {
    cache.delete(accountKey)
    cache.set(accountKey, cached)
  }
  return (cached ?? snapshot)?.profiles.get(modelID) ?? FALLBACK.get(modelID)
}

export function needsRefresh(auth: Extract<Auth.Info, { type: "oauth" }>) {
  const key = CodexResponsesProtocol.accountKey(auth.accountId, auth.access)
  if (!key) return true
  const current = cache.get(key)
  return !current || current.expiresAt <= Date.now()
}

export async function settleRefresh(accountKey: string) {
  await pending.get(accountKey)?.catch(() => undefined)
}

export async function refresh(input: {
  readonly auth: Extract<Auth.Info, { type: "oauth" }>
  readonly endpoint: string
  readonly fetcher?: typeof fetch
  readonly force?: boolean
}) {
  const key = CodexResponsesProtocol.accountKey(input.auth.accountId, input.auth.access)
  if (!key) return load({ ...input, accountKey: "", store: false })
  const current = cache.get(key)
  if (!input.force && current && current.expiresAt > Date.now()) return current
  const active = pending.get(key)
  if (active) return active
  const value = load({ ...input, accountKey: key, store: true }).finally(() => {
    if (pending.get(key) === value) pending.delete(key)
  })
  pending.set(key, value)
  return value
}

export function observeEtag(value: string | undefined, accountKey: string | undefined) {
  if (!value || !accountKey) return false
  const current = cache.get(accountKey)
  if (!current || current.etag === value) return false
  cache.set(accountKey, { ...current, expiresAt: 0 })
  return true
}

async function load(input: {
  readonly auth: Extract<Auth.Info, { type: "oauth" }>
  readonly accountKey: string
  readonly store: boolean
  readonly endpoint: string
  readonly fetcher?: typeof fetch
}) {
  const previous = input.store ? cache.get(input.accountKey) : undefined
  const url = new URL(input.endpoint)
  url.pathname = url.pathname.replace(/responses\/?$/, "models")
  url.searchParams.set("client_version", InstallationVersion)
  const headers = new Headers({
    authorization: `Bearer ${input.auth.access}`,
    originator: "codex_cli_rs",
  })
  if (input.auth.accountId) headers.set("ChatGPT-Account-Id", input.auth.accountId)
  if (previous?.etag) headers.set("If-None-Match", previous.etag)

  const response = await (input.fetcher ?? fetch)(url, { headers, signal: AbortSignal.timeout(3_000) }).catch(
    () => undefined,
  )
  if (response?.status === 304 && previous) {
    return store({ ...previous, expiresAt: Date.now() + CACHE_TTL })
  }
  if (!response?.ok) {
    return store({
      accountKey: input.accountKey,
      profiles: previous?.profiles ?? FALLBACK,
      etag: previous?.etag,
      expiresAt: Date.now() + FAILURE_TTL,
    })
  }

  const body: unknown = await response.json().catch(() => undefined)
  const models = isRecord(body) && Array.isArray(body.models) ? body.models.flatMap(parseModel) : []
  return store({
    accountKey: input.accountKey,
    profiles: models.length > 0 ? new Map(models.map((model) => [model.modelID, model])) : FALLBACK,
    etag: response.headers.get("etag") ?? undefined,
    expiresAt: Date.now() + CACHE_TTL,
  })

  function store(value: Catalog) {
    if (!input.store) return value
    cache.delete(input.accountKey)
    cache.set(input.accountKey, value)
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    return value
  }
}

function parseModel(value: unknown): Profile[] {
  if (!isRecord(value) || typeof value.slug !== "string") return []
  const model = value as Partial<RemoteModel>
  if (typeof model.context_window !== "number" || !Number.isFinite(model.context_window)) return []
  return [
    {
      modelID: value.slug,
      contextWindow: model.context_window,
      autoCompactTokenLimit:
        typeof model.auto_compact_token_limit === "number" ? model.auto_compact_token_limit : undefined,
      compHash: typeof model.comp_hash === "string" ? model.comp_hash : undefined,
      responsesLite: model.use_responses_lite === true,
    },
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export * as CodexResponsesCatalog from "./catalog"
