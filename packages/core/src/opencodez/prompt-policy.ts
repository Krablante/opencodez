export * as OpenCodezPromptPolicy from "./prompt-policy"

import type { OpenCodezPrompts } from "@opencode-ai/schema/opencodez-prompts"
import type { OpenCodezSettings } from "./settings"

let policy: {
  rules: ReadonlyArray<OpenCodezPrompts.Rule>
  variants: ReadonlyArray<OpenCodezPrompts.Variant>
  entries?: ReadonlyArray<{ id: string; name: string }>
} = {
  rules: [],
  variants: [],
}

export function install(next: typeof policy) {
  policy = next
}

export function title(id: string) {
  return policy.entries?.find((entry) => entry.id === id)?.name ?? id.replace(/^(builtin:|file:)/, "")
}

export function system(model: OpenCodezSettings.ModelLike | undefined) {
  const info = identity(model)
  const all = policy.rules.find((rule) => rule.scope === "all")?.prompt
  return (
    (all !== "@builtin" ? all : undefined) ??
    policy.rules.find(
      (rule) => rule.scope === "model" && rule.providerID === info.providerID && rule.target === info.id,
    )?.prompt ??
    policy.rules.find(
      (rule) => rule.scope === "model" && rule.providerID === info.providerID && rule.target === info.apiID,
    )?.prompt ??
    policy.rules.find(
      (rule) =>
        rule.scope === "family" && rule.providerID === info.providerID && rule.target === info.family && !!info.family,
    )?.prompt
  )
}

export function fallback() {
  return policy.rules.find((rule) => rule.scope === "fallback")?.prompt
}

export function all() {
  return policy.rules.find((rule) => rule.scope === "all")?.prompt
}

export function variant(model: OpenCodezSettings.ModelLike | undefined) {
  const info = identity(model)
  return (
    policy.variants.find((rule) => rule.providerID === info.providerID && rule.modelID === info.id)?.variant ??
    policy.variants.find((rule) => rule.providerID === info.providerID && rule.modelID === info.apiID)?.variant
  )
}

function identity(model: OpenCodezSettings.ModelLike | undefined) {
  if (typeof model !== "string") {
    return { providerID: model?.providerID, id: model?.id, apiID: model?.api?.id, family: model?.family }
  }
  const split = model.indexOf("/")
  return {
    providerID: split < 0 ? undefined : model.slice(0, split),
    id: split < 0 ? model : model.slice(split + 1),
    apiID: undefined,
    family: undefined,
  }
}
