export * as OpenCodezContextSettings from "./context-settings"

import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { OpenCodezContext } from "@opencode-ai/schema/opencodez-context"
import { OpenCodezContextPolicy } from "@opencode-ai/core/opencodez/context-policy"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { CodexResponsesCatalog } from "./codex-responses/catalog"
import { usable } from "@/session/overflow"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { Provider } from "@/provider/provider"

const Document = Schema.Struct({
  format: Schema.Literal(1),
  revision: Schema.Int,
  rules: Schema.Array(OpenCodezContext.Rule),
})
const Turn = Schema.Struct({
  turnID: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  values: Schema.Struct({
    ...OpenCodezContext.Values.fields,
    threshold: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0.9)),
  }),
})
const limit = 1024 * 1024
let cache: { file: string; stamp: string; document: typeof Document.Type } | undefined
let writing: Promise<unknown> = Promise.resolve()

export function file() {
  return path.join(Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config, "models", "context.json")
}

export function fail(code: OpenCodezContext.Error["code"], message: string): never {
  throw new OpenCodezContext.Error({ code, message })
}

export async function read() {
  const filename = file()
  const stat = await fs.stat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : "missing"
  if (cache?.file === filename && cache.stamp === stamp) return cache.document
  if (stat && stat.size > limit) fail("invalid", "Context settings exceed 1 MiB")
  const document = stat
    ? Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Document)))(
        await fs.readFile(filename, "utf8"),
      )
    : { format: 1 as const, revision: 0, rules: [] }
  validate(document.rules)
  cache = { file: filename, stamp, document }
  OpenCodezContextPolicy.install(document.rules)
  return document
}

export function merge(
  current: ReadonlyArray<OpenCodezContext.Rule>,
  changes: ReadonlyArray<OpenCodezContext.Rule>,
  remove: ReadonlyArray<OpenCodezContext.Target> = [],
) {
  validate(changes)
  const next = new Map(current.map((rule) => [OpenCodezContextPolicy.key(rule), rule]))
  for (const target of remove) next.delete(OpenCodezContextPolicy.key(target))
  for (const rule of changes)
    next.set(OpenCodezContextPolicy.key(rule), {
      scope: rule.scope,
      providerID: rule.providerID,
      target: rule.target,
      ...OpenCodezContextPolicy.values(rule),
    })
  const rules = [...next.values()].sort((a, b) =>
    OpenCodezContextPolicy.key(a).localeCompare(OpenCodezContextPolicy.key(b)),
  )
  validate(rules)
  return rules
}

export async function change(command: OpenCodezContext.Command) {
  const pending = writing.then(async () => {
    const current = await read()
    if (String(current.revision) !== command.revision)
      fail("conflict", "Context settings changed. Refresh before saving.")
    const rules = merge(current.rules, command.rules, command.remove)
    if (JSON.stringify(rules) === JSON.stringify(current.rules))
      return { changed: false, revision: String(current.revision) }
    const next = { ...current, revision: current.revision + 1, rules }
    const text = JSON.stringify(next, null, 2) + "\n"
    if (Buffer.byteLength(text) > limit) fail("invalid", "Context settings exceed 1 MiB")
    const filename = file()
    await fs.mkdir(path.dirname(filename), { recursive: true })
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" })
      await fs.rename(temporary, filename)
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
    cache = undefined
    await read()
    return { changed: true, revision: String(next.revision) }
  })
  writing = pending.catch(() => {})
  return pending
}

export function decodeBundle(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > limit) fail("invalid", "Context settings exceed 1 MiB")
  const decoded = Schema.decodeUnknownOption(OpenCodezContext.Bundle)(value)
  if (Option.isNone(decoded)) fail("invalid", "Invalid OpenCodez context bundle")
  validate(decoded.value.rules)
  return decoded.value
}

export function preview(value: unknown, catalog: OpenCodezContext.Catalog): OpenCodezContext.Preview {
  const bundle = decodeBundle(value)
  return {
    revision: catalog.revision,
    items: bundle.rules.map((rule) => {
      const current = catalog.rules.find(
        (entry) => OpenCodezContextPolicy.key(entry) === OpenCodezContextPolicy.key(rule),
      )
      const model = catalog.models.find(
        (entry) =>
          entry.providerID === rule.providerID &&
          (rule.scope === "model" ? entry.id === rule.target : entry.family === rule.target),
      )
      return {
        rule,
        current,
        status: !current
          ? "new"
          : JSON.stringify(OpenCodezContextPolicy.values(current)) ===
              JSON.stringify(OpenCodezContextPolicy.values(rule))
            ? "same"
            : "changed",
        active: !!model,
        name: rule.scope === "family" ? rule.target : (model?.name ?? rule.target),
      }
    }),
  }
}

export function validateModels(catalog: OpenCodezContext.Catalog, rules: ReadonlyArray<OpenCodezContext.Rule>) {
  if (
    rules.some(
      (rule) =>
        rule.contextWindow !== undefined &&
        catalog.models.some(
          (model) =>
            model.providerID === rule.providerID &&
            (rule.scope === "model" ? model.id === rule.target : model.family === rule.target) &&
            model.effective.maxTokenLimit <= 0,
        ),
    )
  ) {
    fail("invalid", "The context window must leave room for a model response")
  }
}

export function effective(input: {
  model: Provider.Model
  config: ConfigV1.Info
  remote: boolean
  accountKey?: string
  rules: ReadonlyArray<OpenCodezContext.Rule>
  outputTokenMax?: number
}): OpenCodezContext.Effective {
  const policy = OpenCodezContextPolicy.resolve(input.config, input.model, { remote: input.remote, rules: input.rules })
  const model = OpenCodezContextPolicy.apply(input.model, policy)
  const originalProfile = input.remote ? CodexResponsesCatalog.resolve(input.model, input.accountKey) : undefined
  const profile = input.remote
    ? CodexResponsesCatalog.resolve(input.model, input.accountKey, undefined, policy.contextWindow)
    : undefined
  const contextWindow = input.remote
    ? OpenCodezSettings.responsesCompactionContext(model.limit, profile?.contextWindow)
    : model.limit.input || model.limit.context
  const maxTokenLimit = Math.max(
    0,
    Math.min(
      usable({ cfg: input.config, model, outputTokenMax: input.outputTokenMax }),
      input.remote
        ? OpenCodezSettings.responsesCompactionLimit(
            { opencodez: { responses: { compaction: { threshold: policy.threshold } } } },
            model.limit,
            profile?.contextWindow,
            profile?.autoCompactTokenLimit,
          )
        : Number.POSITIVE_INFINITY,
    ),
  )
  return {
    contextWindow,
    tokenLimit: Math.min(maxTokenLimit, policy.tokenLimit ?? Number.POSITIVE_INFINITY),
    auto: policy.auto ?? true,
    maxContextWindow: input.remote
      ? Math.min(
          input.model.limit.input || input.model.limit.context,
          originalProfile?.maxContextWindow ??
            originalProfile?.contextWindow ??
            OpenCodezSettings.defaults.compaction.context,
        )
      : input.model.limit.input || input.model.limit.context,
    maxTokenLimit,
    remote: input.remote,
  }
}

export function turn(metadata: Record<string, unknown> | undefined, model: Provider.Model, turnID?: string) {
  const decoded = Schema.decodeUnknownOption(Turn)(metadata?.opencodezContextTurn)
  if (Option.isNone(decoded)) return undefined
  const value = decoded.value
  return value.providerID === model.providerID && value.modelID === model.id && (!turnID || value.turnID === turnID)
    ? value
    : undefined
}

export function continueTurn(metadata: Record<string, unknown> | undefined, turnID: string) {
  const decoded = Schema.decodeUnknownOption(Turn)(metadata?.opencodezContextTurn)
  return Option.isSome(decoded) ? { ...metadata, opencodezContextTurn: { ...decoded.value, turnID } } : metadata
}

export async function capture(input: {
  model: Provider.Model
  config: ConfigV1.Info
  metadata?: Record<string, unknown>
  turnID: string
  remote: boolean
}) {
  const existing = turn(input.metadata, input.model, input.turnID)
  if (existing) return existing
  await read()
  return {
    turnID: input.turnID,
    providerID: input.model.providerID,
    modelID: input.model.id,
    values: OpenCodezContextPolicy.resolve(input.config, input.model, { remote: input.remote }),
  }
}

function validate(rules: ReadonlyArray<OpenCodezContext.Rule>) {
  if (rules.length > 1000) fail("invalid", "A context bundle supports at most 1,000 rules")
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!rule.providerID.trim() || rule.providerID.length > 200 || !rule.target.trim() || rule.target.length > 500)
      fail("invalid", "Invalid model or provider identifier")
    if (rule.contextWindow === undefined && rule.tokenLimit === undefined && rule.auto === undefined)
      fail("invalid", "A context rule must contain a setting")
    if (rule.contextWindow !== undefined && rule.tokenLimit !== undefined && rule.tokenLimit >= rule.contextWindow)
      fail("invalid", "Automatic compaction must leave room inside the context window")
    const key = OpenCodezContextPolicy.key(rule)
    if (seen.has(key)) fail("invalid", "Duplicate context target")
    seen.add(key)
  }
}
