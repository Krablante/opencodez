export * as OpenCodezContextPolicy from "./context-policy"

import type { OpenCodezContext } from "@opencode-ai/schema/opencodez-context"
import type { OpenCodezSettings } from "./settings"

export type Model = Exclude<OpenCodezSettings.ModelLike, string> & {
  limit: { context: number; input?: number; output: number }
}
export type Config = OpenCodezSettings.ConfigLike & { compaction?: { auto?: boolean } }
export type Snapshot = OpenCodezContext.Values & { threshold: number }

let rules = new Map<string, OpenCodezContext.Rule>()
const frozen = new WeakMap<object, Snapshot>()

export function key(target: OpenCodezContext.Target) {
  return JSON.stringify([target.scope, target.providerID, target.target])
}

export function install(entries: ReadonlyArray<OpenCodezContext.Rule>) {
  rules = new Map(entries.map((entry) => [key(entry), entry]))
}

export function inherited(config: Config, responses = false) {
  return {
    contextWindow: responses ? config.opencodez?.responses?.context_window : undefined,
    tokenLimit: responses ? config.opencodez?.responses?.compaction?.token_limit : undefined,
    auto: config.compaction?.auto ?? true,
  }
}

export function resolve(
  config: Config,
  model: OpenCodezSettings.ModelLike | undefined,
  options?: { remote?: boolean; rules?: ReadonlyArray<OpenCodezContext.Rule> },
): Snapshot {
  if (typeof model !== "object" || !model) return { ...inherited(config, options?.remote), threshold: 0.9 }
  const snapshot = options?.rules ? undefined : frozen.get(model)
  if (snapshot) return snapshot
  const find = (scope: OpenCodezContext.Target["scope"], target?: string) =>
    target && model.providerID
      ? options?.rules
        ? options.rules.find(
            (entry) => entry.scope === scope && entry.providerID === model.providerID && entry.target === target,
          )
        : rules.get(key({ scope, providerID: model.providerID, target }))
      : undefined
  const family = find("family", model.family)
  const base = find("model", model.api?.id)
  const exact = find("model", model.id)
  return {
    ...inherited(config, options?.remote),
    ...values(family),
    ...values(base),
    ...values(exact),
    // An explicit personal token threshold replaces the legacy earlier trigger,
    // while retaining Codex's 90% request safety ceiling.
    threshold:
      (exact?.tokenLimit ?? base?.tokenLimit ?? family?.tokenLimit) === undefined
        ? (config.opencodez?.responses?.compaction?.threshold ?? 0.9)
        : 0.9,
  }
}

export function apply<T extends Model>(model: T, snapshot: Snapshot): T {
  const context =
    snapshot.contextWindow === undefined
      ? model.limit.context
      : Math.min(model.limit.context || snapshot.contextWindow, snapshot.contextWindow)
  const next = {
    ...model,
    limit: {
      ...model.limit,
      context,
      ...(model.limit.input === undefined ? {} : { input: Math.min(model.limit.input, context) }),
    },
  }
  frozen.set(next, snapshot)
  return next
}

export function snapshot(model: object) {
  return frozen.get(model)
}

export function values(rule: OpenCodezContext.Values | undefined): OpenCodezContext.Values {
  return {
    ...(rule?.contextWindow === undefined ? {} : { contextWindow: rule.contextWindow }),
    ...(rule?.tokenLimit === undefined ? {} : { tokenLimit: rule.tokenLimit }),
    ...(rule?.auto === undefined ? {} : { auto: rule.auto }),
  }
}
