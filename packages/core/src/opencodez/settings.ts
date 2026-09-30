export * as OpenCodezSettings from "./settings"

import { OpenCodezPromptPolicy } from "./prompt-policy"

export type ConfigLike = Record<string, unknown> & {
  opencodez?: {
    responses?: {
      system?: string | Record<string, string>
      wire?: "legacy" | "codex"
      context_window?: number
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
    // Codex rust-v0.153.4 defaults to a 272k working window for the ChatGPT
    // Responses models even when the general provider catalog is larger.
    context: 272_000,
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
    "gpt-6-astra": "codex_gpt_6_astra",
    "gpt-6-sol": "codex_gpt_6_sol",
    "gpt-6-luna": "codex_gpt_6_luna",
    "gpt-6.1-sol": "codex_gpt_6_1_sol",
  },
}

export function defaultSystem(config: ConfigLike | undefined, model: ModelLike | undefined) {
  const existing = config?.opencodez?.responses?.system
  const configured = typeof existing === "string" && OpenCodezPromptPolicy.all() === "@builtin" ? undefined : existing
  if (typeof configured === "string" && OpenCodezPromptPolicy.all() === undefined) return configured
  const override = OpenCodezPromptPolicy.system(model)
  if (override === "@builtin") {
    const name = builtinSystem(model)
    return name ? `builtin:${name}` : undefined
  }
  if (override) return override
  if (typeof configured === "string") return configured
  const fallback = OpenCodezPromptPolicy.fallback()
  if (configured) {
    const explicit = resolveModelMapping(
      Object.fromEntries(Object.entries(configured).filter(([key]) => key !== "default")),
      model,
    )
    if (explicit) return explicit
    const assigned = builtinAssignment(model)
    if (assigned) return assigned
    if (fallback === "@builtin") {
      const name = builtinSystem(model)
      return name ? `builtin:${name}` : undefined
    }
    return fallback ?? configured.default ?? builtinSystem(model)
  }
  const assigned = builtinAssignment(model)
  if (assigned) return assigned
  if (fallback === "@builtin") {
    const name = builtinSystem(model)
    return name ? `builtin:${name}` : undefined
  }
  return fallback ?? builtinSystem(model)
}

function builtinAssignment(model: ModelLike | undefined) {
  if (!isOpenAIResponsesGPT(model)) return undefined
  return resolveModelMapping(defaults.system, model, false)
}

function builtinSystem(model: ModelLike | undefined) {
  if (!isOpenAIResponsesGPT(model)) return undefined
  return resolveModelMapping(defaults.system, model) ?? defaults.system.default
}

export function responsesWire(config: ConfigLike | undefined) {
  return config?.opencodez?.responses?.wire ?? "codex"
}

export function responsesContextWindow(config: ConfigLike | undefined) {
  return config?.opencodez?.responses?.context_window
}

export function responsesCompaction(config: ConfigLike | undefined) {
  const configured = config?.opencodez?.responses?.compaction
  return {
    threshold: configured?.threshold ?? defaults.compaction.threshold,
    token_limit: configured?.token_limit,
  }
}

export function responsesCompactionLimit(
  config: ConfigLike | undefined,
  model: { input?: number; context: number },
  responsesContext?: number,
  autoCompactTokenLimit?: number,
) {
  const policy = responsesCompaction(config)
  const base = responsesCompactionContext(model, responsesContext)
  let limit = Math.max(1, Math.floor(base * policy.threshold))
  if (autoCompactTokenLimit !== undefined) limit = Math.min(limit, autoCompactTokenLimit)
  if (policy.token_limit !== undefined) limit = Math.min(limit, policy.token_limit)
  return limit
}

export function responsesCompactionContext(model: { input?: number; context: number }, responsesContext?: number) {
  return Math.min(model.input || model.context, responsesContext ?? defaults.compaction.context)
}

export function responsesCompactionPayloadLimit(model: { input?: number; context: number }, responsesContext?: number) {
  return Math.floor(responsesCompactionContext(model, responsesContext) * defaults.compaction.threshold)
}

function resolveModelMapping(mapping: Record<string, string>, model: ModelLike | undefined, fallback = true) {
  const info = modelInfo(model)
  if (!info.id && !info.apiID) return fallback ? mapping.default : undefined
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
  return fallback ? mapping.default : undefined
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
