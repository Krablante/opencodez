import type { Auth } from "@/auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite"
export const RESPONSES_LITE_METADATA = "ws_request_header_x_openai_internal_codex_responses_lite"

export type Profile = {
  readonly modelID: string
  readonly contextWindow: number
  readonly autoCompactTokenLimit?: number
  readonly compHash?: string
  readonly responsesLite: boolean
}

type Catalog = {
  readonly accountKey: string
  readonly profiles: ReadonlyMap<string, Profile>
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
const FALLBACK_PROFILES: Profile[] = [
  { modelID: "gpt-5.4", contextWindow: 272_000, compHash: "2911", responsesLite: false },
  { modelID: "gpt-5.4-mini", contextWindow: 272_000, compHash: "2911", responsesLite: false },
  { modelID: "gpt-5.5", contextWindow: 272_000, compHash: "2911", responsesLite: false },
  { modelID: "gpt-5.6-luna", contextWindow: 272_000, compHash: "3000", responsesLite: true },
  { modelID: "gpt-5.6-terra", contextWindow: 272_000, compHash: "3000", responsesLite: true },
  { modelID: "gpt-5.6-sol", contextWindow: 272_000, compHash: "3000", responsesLite: true },
]
const FALLBACK = new Map(FALLBACK_PROFILES.map((profile) => [profile.modelID, profile]))

let cache: Catalog | undefined
let pending: { readonly accountKey: string; readonly value: Promise<Catalog> } | undefined

export async function initialize<T extends Record<string, Model>>(
  models: T,
  input: {
    readonly auth: Extract<Auth.Info, { type: "oauth" }>
    readonly endpoint: string
    readonly fetcher?: typeof fetch
  },
) {
  await refresh(input)
  return models
}

export function resolve(model: Model): Profile | undefined {
  return resolveID(model.api.id)
}

export function resolveID(modelID: string): Profile | undefined {
  return cache?.profiles.get(modelID) ?? FALLBACK.get(modelID)
}

export function needsRefresh(auth: Extract<Auth.Info, { type: "oauth" }>) {
  return !cache || cache.accountKey !== identityKey(auth) || cache.expiresAt <= Date.now()
}

export async function refresh(input: {
  readonly auth: Extract<Auth.Info, { type: "oauth" }>
  readonly endpoint: string
  readonly fetcher?: typeof fetch
  readonly force?: boolean
}) {
  const accountKey = identityKey(input.auth)
  if (!input.force && cache?.accountKey === accountKey && cache.expiresAt > Date.now()) return cache
  if (pending?.accountKey === accountKey) return pending.value
  const value = load({ ...input, accountKey }).finally(() => {
    if (pending?.value === value) pending = undefined
  })
  pending = { accountKey, value }
  return value
}

export function observeEtag(value: string | undefined) {
  if (!value || !cache || cache.etag === value) return false
  cache = { ...cache, expiresAt: 0 }
  return true
}

async function load(input: {
  readonly auth: Extract<Auth.Info, { type: "oauth" }>
  readonly accountKey: string
  readonly endpoint: string
  readonly fetcher?: typeof fetch
}) {
  const previous = cache?.accountKey === input.accountKey ? cache : undefined
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
    cache = { ...previous, expiresAt: Date.now() + CACHE_TTL }
    return cache
  }
  if (!response?.ok) {
    cache = {
      accountKey: input.accountKey,
      profiles: previous?.profiles ?? FALLBACK,
      etag: previous?.etag,
      expiresAt: Date.now() + FAILURE_TTL,
    }
    return cache
  }

  const body: unknown = await response.json().catch(() => undefined)
  const models = isRecord(body) && Array.isArray(body.models) ? body.models.flatMap(parseModel) : []
  cache = {
    accountKey: input.accountKey,
    profiles: models.length > 0 ? new Map(models.map((model) => [model.modelID, model])) : FALLBACK,
    etag: response.headers.get("etag") ?? undefined,
    expiresAt: Date.now() + CACHE_TTL,
  }
  return cache
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

function identityKey(auth: Extract<Auth.Info, { type: "oauth" }>) {
  const subject = tokenSubject(auth.access)
  return new Bun.CryptoHasher("sha256").update(auth.accountId ?? subject ?? "unknown").digest("hex")
}

function tokenSubject(access: string) {
  const payload = access.split(".")[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString())
    return isRecord(claims) && typeof claims.sub === "string" ? claims.sub : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export * as OpenCodezResponsesModel from "./responses-model"
