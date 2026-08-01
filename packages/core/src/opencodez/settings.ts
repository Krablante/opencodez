export * as OpenCodezSettings from "./settings"

export type ConfigLike = Record<string, unknown> & {
  opencodez?: {
    responses?: {
      system?: string | Record<string, string>
      wire?: "legacy" | "codex"
      compaction?: {
        threshold?: number
        token_limit?: number
      }
    }
  }
}

export type ModelLike =
  | string
  | {
      id?: string
      providerID?: string
      family?: string
      api?: {
        id?: string
        npm?: string
      }
    }

export const defaults = {
  compaction: {
    threshold: 0.9,
  },
  system: {
    default: "codex_gpt_5_5",
    "gpt-5.2": "codex_gpt_5_2",
    "gpt-5.2-codex": "codex_gpt_5_2_codex",
    "gpt-5.3-codex": "codex_gpt_5_3_codex",
    "gpt-5.3-codex-spark": "codex_gpt_5_3_codex",
    "gpt-5.4": "codex_gpt_5_4",
    "gpt-5.4-mini": "codex_gpt_5_4_mini",
    "gpt-5.5": "codex_gpt_5_5",
    "gpt-5.6-luna": "codex_gpt_5_6_luna_terra",
    "gpt-5.6-terra": "codex_gpt_5_6_luna_terra",
    "gpt-5.6-sol": "codex_gpt_5_6_sol",
  },
}

export function defaultSystem(config: ConfigLike | undefined, model: ModelLike | undefined) {
  const configured = config?.opencodez?.responses?.system
  if (typeof configured === "string") return configured
  if (configured) return resolveModelMapping(configured, model)
  if (!isOpenAIResponsesGPT(model)) return undefined
  return resolveModelMapping(defaults.system, model) ?? defaults.system.default
}

export function responsesWire(config: ConfigLike | undefined) {
  return config?.opencodez?.responses?.wire ?? "codex"
}

export function responsesCompaction(config: ConfigLike | undefined) {
  const configured = config?.opencodez?.responses?.compaction
  return {
    threshold: configured?.threshold ?? defaults.compaction.threshold,
    token_limit: configured?.token_limit,
  }
}

export function responsesCompactionLimit(config: ConfigLike | undefined, model: { input?: number; context: number }) {
  const policy = responsesCompaction(config)
  const base = model.input || model.context
  let limit = Math.max(1, Math.floor(base * policy.threshold))
  if (policy.token_limit !== undefined) limit = Math.min(limit, policy.token_limit)
  return limit
}

function resolveModelMapping(mapping: Record<string, string>, model: ModelLike | undefined) {
  const info = modelInfo(model)
  if (!info.id && !info.apiID) return mapping.default
  const candidates = new Set(
    [
      info.id,
      info.id?.toLowerCase(),
      info.apiID,
      info.apiID?.toLowerCase(),
      info.family,
      info.family?.toLowerCase(),
      info.providerID && `${info.providerID}/${info.id}`,
      info.providerID && `${info.providerID}/${info.id}`.toLowerCase(),
      info.providerID && info.apiID && `${info.providerID}/${info.apiID}`,
      info.providerID && info.apiID && `${info.providerID}/${info.apiID}`.toLowerCase(),
    ].filter((value): value is string => Boolean(value)),
  )
  const last = (info.apiID ?? info.id)?.split("/").at(-1)
  if (last) {
    candidates.add(last)
    candidates.add(last.toLowerCase())
  }
  for (const key of candidates) {
    if (mapping[key]) return mapping[key]
  }
  return mapping.default
}

function isOpenAIResponsesGPT(model: ModelLike | undefined) {
  const info = modelInfo(model)
  return (
    info.providerID === "openai" &&
    info.apiNpm === "@ai-sdk/openai" &&
    (info.apiID ?? info.id ?? "").toLowerCase().startsWith("gpt-")
  )
}

function modelInfo(model: ModelLike | undefined) {
  if (typeof model === "string") {
    const [providerID, ...rest] = model.includes("/") ? model.split("/") : []
    return {
      id: rest.length ? rest.join("/") : model,
      providerID,
      family: undefined,
      apiID: undefined,
      apiNpm: undefined,
    }
  }
  return {
    id: model?.id,
    providerID: model?.providerID,
    family: model?.family,
    apiID: model?.api?.id,
    apiNpm: model?.api?.npm,
  }
}
