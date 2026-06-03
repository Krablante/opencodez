export * as OpenCodezSettings from "./settings"

export type ConfigLike = Record<string, unknown> & {
  opencodez?: {
    responses?: {
      system?: string | Record<string, string>
      tone?: string
    }
    pruning?: {
      enabled?: boolean
      pruning_size?: number
      preserve_tools?: string[]
      prune?: {
        reasoning?: boolean
        tool?: boolean
      }
    }
  }
}

export const defaults = {
  system: {
    default: "codex_gpt_5_5",
    "gpt-5.2": "codex_gpt_5_2",
    "gpt-5.4": "codex_gpt_5_4",
    "gpt-5.5": "codex_gpt_5_5",
  },
  tone: "codex_pragmatic",
  pruning: {
    enabled: true,
    pruning_size: 20_000,
    preserve_tools: [] as string[],
    prune: {
      reasoning: true,
      tool: true,
    },
  },
}

export function defaultSystem(config: ConfigLike | undefined, modelID: string | undefined) {
  const configured = config?.opencodez?.responses?.system
  if (typeof configured === "string") return configured
  const mapping = configured ?? defaults.system
  return resolveModelMapping(mapping, modelID) ?? defaults.system.default
}

export function defaultTone(config: ConfigLike | undefined) {
  return config?.opencodez?.responses?.tone ?? defaults.tone
}

export function pruning(config: ConfigLike | undefined) {
  const configured = config?.opencodez?.pruning
  return {
    enabled: configured?.enabled ?? defaults.pruning.enabled,
    pruning_size: configured?.pruning_size ?? defaults.pruning.pruning_size,
    preserve_tools: configured?.preserve_tools ?? defaults.pruning.preserve_tools,
    prune: {
      reasoning: configured?.prune?.reasoning ?? defaults.pruning.prune.reasoning,
      tool: configured?.prune?.tool ?? defaults.pruning.prune.tool,
    },
  }
}

function resolveModelMapping(mapping: Record<string, string>, modelID: string | undefined) {
  if (!modelID) return mapping.default
  const candidates = new Set<string>([modelID, modelID.toLowerCase()])
  const last = modelID.split("/").at(-1)
  if (last) {
    candidates.add(last)
    candidates.add(last.toLowerCase())
  }
  for (const key of candidates) {
    if (mapping[key]) return mapping[key]
  }
  return mapping.default
}
