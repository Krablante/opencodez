export * as OpenCodezPromptLibrary from "./prompt-library"

import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import { defaultPromptAssets } from "./default-prompts"
import { SystemPrompt } from "@/session/system"
import { OpenCodezPromptStore } from "./prompt-store"
import { OpenCodezPrompts } from "@opencode-ai/schema/opencodez-prompts"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { Option, Schema } from "effect"

let migration: { directory: string; promise: Promise<void> } | undefined

export interface Entry {
  name: string
  path: string
  source: "builtin" | "library"
}

export function directories() {
  const config = Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config
  const root = path.join(config, "prompts")
  return {
    root,
    system: path.join(root, "core"),
    config: path.join(config, "opencode.jsonc"),
  }
}

export async function ensureDefaults() {
  const dirs = directories()
  await OpenCodezPromptStore.read(dirs.root)
  if (migration?.directory === dirs.system) return migration.promise
  const promise = fs.mkdir(dirs.system, { recursive: true }).then(() => removeLegacyCopies(dirs.system))
  migration = { directory: dirs.system, promise }
  try {
    await promise
  } catch (error) {
    if (migration?.promise === promise) migration = undefined
    throw error
  }
}

export async function list(): Promise<Entry[]> {
  await ensureDefaults()
  const dir = directories().system
  const ext = ".md"
  const files = await fs.readdir(dir).catch(() => [])
  const library = files
    .filter((file) => file.endsWith(ext))
    .map((file) => ({
      name: path.basename(file, ext),
      path: path.join(dir, file),
      source: "library" as const,
    }))
  const builtin = SystemPrompt.builtinEntries().map((item) => ({
    ...item,
    source: "builtin" as const,
  }))
  const bundled = Object.keys(defaultPromptAssets.core).map((file) => ({
    name: path.basename(file, ext),
    path: `bundled:${file}`,
    source: "builtin" as const,
  }))
  const stored = await OpenCodezPromptStore.read(directories().root)
  const managed = stored.entries
    .filter((entry) => !entry.deleted)
    .map((entry) => ({ name: entry.id, path: `managed:${entry.id}`, source: "library" as const }))
  return Array.from(
    new Map(
      [...builtin, ...bundled, ...library.filter((entry) => !stored.files[entry.name]?.deleted), ...managed].map(
        (item) => [item.name, item],
      ),
    ).values(),
  ).sort((a, b) => a.name.localeCompare(b.name))
}

export async function get(name: string) {
  await ensureDefaults()
  const stored = await OpenCodezPromptStore.read(directories().root)
  const managed = stored.entries.find((entry) => entry.id === name)
  if (managed) return { name, path: `managed:${name}`, source: "library" as const }
  if (name.startsWith("builtin:")) {
    const id = name.slice(8)
    if (`${id}.md` in defaultPromptAssets.core || SystemPrompt.builtinPrompt(id) !== undefined)
      return { name, path: `bundled:${id}.md`, source: "builtin" as const }
    return undefined
  }
  if (name.startsWith("file:")) name = name.slice(5)
  if (!validName(name)) return undefined
  const library = path.join(directories().system, `${name}.md`)
  if (await Bun.file(library).exists()) return { name, path: library, source: "library" as const }
  if (`${name}.md` in defaultPromptAssets.core) {
    return { name, path: `bundled:${name}.md`, source: "builtin" as const }
  }
  if (SystemPrompt.builtinPrompt(name) !== undefined)
    return { name, path: `builtin:${name}`, source: "builtin" as const }
  return undefined
}

export async function readPrompt(name: string) {
  const entry = await get(name)
  if (!entry) return undefined
  if (entry.path.startsWith("managed:")) {
    return (await OpenCodezPromptStore.read(directories().root)).entries.find((item) => item.id === name)?.text
  }
  if (entry.source === "library") return Bun.file(entry.path).text()
  const id = name.replace(/^builtin:/, "")
  const bundled = (defaultPromptAssets.core as Record<string, string>)[`${id}.md`]
  return bundled ?? SystemPrompt.builtinPrompt(id)
}

export async function catalog(
  models: ReadonlyArray<OpenCodezPrompts.Model>,
  config?: OpenCodezSettings.ConfigLike,
  defaults?: ReadonlyMap<string, string>,
): Promise<OpenCodezPrompts.Catalog> {
  await ensureDefaults()
  const stored = await OpenCodezPromptStore.read(directories().root)
  const builtins = [
    ...new Set([
      ...SystemPrompt.builtinEntries().map((item) => item.name),
      ...Object.keys(defaultPromptAssets.core).map((file) => path.basename(file, ".md")),
    ]),
  ]
  const builtinEntries = builtins.map((name) => ({
    id: `builtin:${name}`,
    name: builtinTitle(name),
    description: "",
    source: "builtin" as const,
    deleted: false,
    version: OpenCodezPromptStore.hash(
      (defaultPromptAssets.core as Record<string, string>)[`${name}.md`] ?? SystemPrompt.builtinPrompt(name) ?? "",
    ),
    sourceUpdated: false,
  }))
  const files = (await fs.readdir(directories().system)).filter((name) => name.endsWith(".md"))
  const fileEntries = files.map((file) => {
    const name = path.basename(file, ".md")
    const meta = stored.files[name]
    return {
      id: `file:${name}`,
      name: meta?.name ?? name,
      description: meta?.description ?? "",
      source: "library" as const,
      deleted: meta?.deleted ?? false,
      version: "file",
      sourceUpdated: false,
    }
  })
  const entries = [
    ...builtinEntries,
    ...fileEntries,
    ...stored.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      source: "library" as const,
      deleted: entry.deleted,
      version: OpenCodezPromptStore.hash(JSON.stringify(entry)),
      origin: entry.origin,
      sourceUpdated:
        !!entry.origin &&
        builtinEntries.some((item) => item.id === entry.origin?.id && item.version !== entry.origin.version),
    })),
  ].sort((a, b) => a.name.localeCompare(b.name))
  const builtinRules: OpenCodezPrompts.Rule[] = models.flatMap((model) => {
    const prompt = OpenCodezSettings.defaults.system[model.apiID as keyof typeof OpenCodezSettings.defaults.system]
    return prompt && model.providerID === "openai"
      ? [
          {
            scope: "model" as const,
            providerID: model.providerID,
            target: model.id,
            prompt: resolveID(prompt, entries),
            source: entries.some((entry) => entry.id === `file:${prompt}`) ? ("legacy" as const) : ("builtin" as const),
          },
        ]
      : []
  })
  const legacy = config?.opencodez?.responses?.system
  const legacyRules: OpenCodezPrompts.Rule[] =
    typeof legacy === "string"
      ? [{ scope: "all", providerID: "", target: "", prompt: resolveID(legacy, entries), source: "legacy" }]
      : Object.entries(legacy ?? {}).map(([key, value]) => {
          const model = models.find(
            (item) => item.id === key || item.apiID === key || `${item.providerID}/${item.id}` === key,
          )
          const family = models.find((item) => item.family === key)
          return {
            scope: key === "default" ? "fallback" : model ? "model" : "family",
            providerID: model?.providerID ?? family?.providerID ?? "",
            target: key === "default" ? "" : (model?.id ?? key),
            prompt: resolveID(value, entries),
            source: "legacy",
          }
        })
  return {
    revision: String(stored.revision),
    entries,
    rules: [...builtinRules, ...legacyRules, ...stored.rules.map((rule) => ({ ...rule, source: "user" as const }))],
    variants: stored.variants,
    models: models.map((model) => ({
      ...model,
      effectivePrompt: resolveID(
        defaults?.get(`${model.providerID}/${model.id}`) ?? SystemPrompt.providerNameFromID(model.apiID),
        entries,
      ),
    })),
  }
}

export async function item(id: string): Promise<OpenCodezPrompts.Item> {
  const current = await catalog([])
  const resolved = resolveID(id, current.entries)
  const entry = current.entries.find((entry) => entry.id === resolved)
  if (!entry) OpenCodezPromptStore.fail("missing", "Prompt not found")
  const text = await readPrompt(resolved)
  if (text === undefined) OpenCodezPromptStore.fail("missing", "Prompt text is unavailable")
  return { ...entry, text, version: entry.version === "file" ? OpenCodezPromptStore.hash(text) : entry.version }
}

function resolveID(id: string, entries: ReadonlyArray<OpenCodezPrompts.Entry>) {
  if (entries.some((entry) => entry.id === id)) return id
  return (
    entries.find((entry) => entry.id === `file:${id}`)?.id ??
    entries.find((entry) => entry.id === `builtin:${id}`)?.id ??
    id
  )
}

function builtinTitle(id: string) {
  const model = /^codex_gpt_(\d+)(?:_(\d+))?(.*)$/.exec(id)
  if (model) {
    const suffix = model[3]
      .split("_")
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(" / ")
    return `Codex · GPT-${model[1]}${model[2] ? `.${model[2]}` : ""}${suffix ? ` ${suffix}` : ""}`
  }
  if (id === "default") return "OpenCode"
  const name =
    id === "gpt"
      ? "GPT"
      : id
          .split("-")
          .map((word) => word[0].toUpperCase() + word.slice(1))
          .join(" ")
  return `OpenCode · ${name}`
}

function validText(text: string | undefined) {
  if (text === undefined || !text.trim()) OpenCodezPromptStore.fail("invalid", "Prompt text cannot be empty")
  if (Buffer.byteLength(text) > 1024 * 1024) OpenCodezPromptStore.fail("invalid", "A prompt cannot exceed 1 MiB")
  return text
}

function validTitle(name: string | undefined) {
  if (!name?.trim() || name.length > 200)
    OpenCodezPromptStore.fail("invalid", "Use a prompt name between 1 and 200 characters")
  return name.trim()
}

function normalizeRule(rule: OpenCodezPrompts.Rule): OpenCodezPrompts.Rule {
  return {
    scope: rule.scope,
    providerID: rule.scope === "all" || rule.scope === "fallback" ? "" : rule.providerID,
    target: rule.scope === "all" || rule.scope === "fallback" ? "" : rule.target,
    prompt: rule.prompt,
  }
}

function contentFingerprint(entry: { name: string; description: string; text: string }) {
  return OpenCodezPromptStore.hash(
    JSON.stringify({ name: entry.name, description: entry.description, text: entry.text }),
  )
}

function validDescription(value: string | undefined) {
  if (value && value.length > 2000) OpenCodezPromptStore.fail("invalid", "A description cannot exceed 2000 characters")
  return value ?? ""
}

function importedID(id: string) {
  if (/^user-[a-f0-9-]{36}$/.test(id)) return id
  const digest = OpenCodezPromptStore.hash(`opencodez-import:${id}`).slice(0, 32)
  return `user-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`
}

export async function mutate(
  command: OpenCodezPrompts.Command,
  legacyRules: ReadonlyArray<OpenCodezPrompts.Rule> = [],
) {
  const next = await OpenCodezPromptStore.change(directories().root, command.revision, async (stored) => {
    if (command.action === "rules" || command.action === "variants") {
      const rules = command.rules?.map(normalizeRule) ?? stored.rules
      const keys = rules.map((rule) => `${rule.scope}:${rule.providerID}:${rule.target}`)
      if (new Set(keys).size !== keys.length)
        OpenCodezPromptStore.fail("invalid", "A model or family can have only one rule")
      for (const rule of rules) {
        if (rule.prompt === "@builtin") continue
        const target = await item(rule.prompt)
        if (target.deleted) OpenCodezPromptStore.fail("invalid", "Deleted prompts cannot receive new assignments")
      }
      return { ...stored, rules, variants: command.variants ?? stored.variants }
    }
    if (command.action === "import") {
      if ((command.items?.length ?? 0) > 1000)
        OpenCodezPromptStore.fail("invalid", "A bundle cannot contain more than 1000 prompts")
      if (new Set(command.items?.map((entry) => entry.id)).size !== command.items?.length)
        OpenCodezPromptStore.fail("invalid", "A bundle contains duplicate prompt identifiers")
      let entries = [...stored.entries]
      const remapped = new Map<string, string>()
      for (const incoming of command.items ?? []) {
        const existing = entries.find((entry) => entry.id === incoming.id || entry.id === importedID(incoming.id))
        if (incoming.mode === "keep") {
          if (existing) remapped.set(incoming.id, existing.id)
          continue
        }
        const name = validTitle(incoming.name)
        const text = validText(incoming.text)
        const id = incoming.mode === "copy" ? `user-${crypto.randomUUID()}` : (existing?.id ?? importedID(incoming.id))
        remapped.set(incoming.id, id)
        if (
          entries.some(
            (entry) =>
              entry.id === id &&
              contentFingerprint(entry) === contentFingerprint({ name, description: incoming.description, text }),
          )
        )
          continue
        const entry = {
          id,
          name,
          description: validDescription(incoming.description),
          text,
          deleted: false,
          origin: incoming.origin,
          importHash: contentFingerprint({ name, description: incoming.description, text }),
        }
        entries = [...entries.filter((entry) => entry.id !== id), entry]
      }
      const rules = [...stored.rules]
      for (const supplied of command.rules ?? []) {
        const rule = normalizeRule(supplied)
        const prompt = remapped.get(rule.prompt) ?? rule.prompt
        if (
          prompt !== "@builtin" &&
          !entries.some((entry) => entry.id === prompt && !entry.deleted) &&
          !(await get(prompt))
        )
          OpenCodezPromptStore.fail("invalid", "Imported assignment refers to a missing prompt")
        const index = rules.findIndex(
          (entry) => entry.scope === rule.scope && entry.providerID === rule.providerID && entry.target === rule.target,
        )
        if (index >= 0) rules.splice(index, 1)
        rules.push({ ...rule, prompt, source: undefined })
      }
      return { ...stored, entries, rules }
    }
    if (command.id?.startsWith("builtin:"))
      OpenCodezPromptStore.fail("readonly", "Built-in prompts are read-only. Create a copy instead.")
    if (command.action === "save") {
      const text = validText(command.text)
      const name = validTitle(command.name)
      if (command.id?.startsWith("file:")) {
        const previous = await item(command.id)
        if (previous.version !== command.version)
          OpenCodezPromptStore.fail("conflict", "The prompt changed. Refresh before saving.")
        const file = await get(command.id)
        if (!file || file.source !== "library") OpenCodezPromptStore.fail("missing", "Prompt file not found")
        await OpenCodezPromptStore.writeText(file.path, text)
        return {
          ...stored,
          files: {
            ...stored.files,
            [command.id.slice(5)]: { name, description: validDescription(command.description), deleted: false },
          },
        }
      }
      const previous = stored.entries.find((entry) => entry.id === command.id)
      if (command.id && !previous) OpenCodezPromptStore.fail("missing", "Prompt not found")
      const entry = {
        id: previous?.id ?? `user-${crypto.randomUUID()}`,
        name,
        description: validDescription(command.description),
        text,
        deleted: previous?.deleted ?? false,
        origin: previous?.origin ?? command.origin,
        importHash: previous?.importHash,
      }
      return { ...stored, entries: [...stored.entries.filter((item) => item.id !== entry.id), entry] }
    }
    if (!command.id) OpenCodezPromptStore.fail("invalid", "Prompt id is required")
    const previous = await item(command.id)
    if (previous.source === "builtin") OpenCodezPromptStore.fail("readonly", "Built-in prompts are read-only")
    const deleted = command.action === "delete"
    return {
      ...stored,
      entries: stored.entries.map((entry) => (entry.id === previous.id ? { ...entry, deleted } : entry)),
      files: previous.id.startsWith("file:")
        ? {
            ...stored.files,
            [previous.id.slice(5)]: { name: previous.name, description: previous.description, deleted },
          }
        : stored.files,
      rules: deleted
        ? [
            ...stored.rules.filter(
              (rule) => rule.prompt !== previous.id && rule.prompt !== previous.id.replace(/^file:/, ""),
            ),
            ...legacyRules
              .filter(
                (rule) =>
                  rule.source === "legacy" &&
                  (rule.prompt === previous.id || rule.prompt === previous.id.replace(/^file:/, "")) &&
                  !stored.rules.some(
                    (personal) =>
                      personal.scope === rule.scope &&
                      personal.providerID === rule.providerID &&
                      personal.target === rule.target,
                  ),
              )
              .map((rule) => ({ ...rule, prompt: "@builtin", source: undefined })),
          ]
        : stored.rules,
    }
  })
  return String(next.revision)
}

export async function preview(value: unknown): Promise<OpenCodezPrompts.Preview> {
  const decoded = Schema.decodeUnknownOption(OpenCodezPrompts.Bundle)(value)
  if (Option.isNone(decoded)) OpenCodezPromptStore.fail("invalid", "Unsupported OpenCodez prompt bundle")
  const bundle = decoded.value
  if (bundle.items.length > 1000) OpenCodezPromptStore.fail("invalid", "A bundle cannot contain more than 1000 prompts")
  if (new Set(bundle.items.map((entry) => entry.id)).size !== bundle.items.length)
    OpenCodezPromptStore.fail("invalid", "A bundle contains duplicate prompt identifiers")
  const current = await catalog([])
  const stored = await OpenCodezPromptStore.read(directories().root)
  return {
    items: await Promise.all(
      bundle.items.map(async (incoming) => {
        validTitle(incoming.name)
        validDescription(incoming.description)
        validText(incoming.text)
        const existing =
          current.entries.find((item) => item.id === importedID(incoming.id)) ??
          current.entries.find((item) => item.id === incoming.id)
        const local = existing ? await item(existing.id) : undefined
        const baseline = stored.entries.find((entry) => entry.id === existing?.id)?.importHash
        return {
          ...incoming,
          status: local ? (contentFingerprint(local) === contentFingerprint(incoming) ? "same" : "changed") : "new",
          builtin: existing?.source === "builtin",
          replaceable: !existing || existing.id.startsWith("user-"),
          mode: local
            ? baseline &&
              baseline === contentFingerprint(local) &&
              contentFingerprint(local) !== contentFingerprint(incoming)
              ? ("replace" as const)
              : ("keep" as const)
            : ("replace" as const),
        }
      }),
    ),
    rules: bundle.rules,
  }
}

export async function bundle(
  ids: ReadonlyArray<string>,
  includeRules: boolean,
  rules?: ReadonlyArray<OpenCodezPrompts.Rule>,
  models: ReadonlyArray<OpenCodezPrompts.Model> = [],
) {
  const items = await Promise.all(
    ids.map(async (id) => {
      const entry = await item(id)
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        text: entry.text,
        origin: entry.origin ?? (entry.source === "builtin" ? { id: entry.id, version: entry.version } : undefined),
      }
    }),
  )
  const stored = await OpenCodezPromptStore.read(directories().root)
  const allRules = [
    ...new Map(
      (rules ?? stored.rules).map((rule) => [`${rule.scope}/${rule.providerID}/${rule.target}`, rule]),
    ).values(),
  ]
  const selected = allRules.filter((rule) => ids.includes(rule.prompt))
  return {
    format: "opencodez-prompts" as const,
    version: 1 as const,
    items,
    rules: includeRules
      ? allRules
          .filter(
            (rule) =>
              selected.includes(rule) ||
              (rule.prompt === "@builtin" &&
                selected.some(
                  (parent) =>
                    rule.scope === "all" ||
                    parent.scope === "all" ||
                    (parent.scope === "family" &&
                      rule.scope === "model" &&
                      parent.providerID === rule.providerID &&
                      models.some(
                        (model) =>
                          model.providerID === rule.providerID &&
                          model.id === rule.target &&
                          model.family === parent.target,
                      )),
                )),
          )
          .map(({ scope, providerID, target, prompt }) => ({ scope, providerID, target, prompt }))
      : [],
  }
}

function validName(name: string) {
  return name.length > 0 && name !== "." && name !== ".." && path.basename(name) === name
}

const Turn = Schema.Struct({
  turnID: Schema.String,
  prompt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  disabled: Schema.Boolean,
})
export function turnSnapshot(metadata: Record<string, unknown> | undefined, turnID: string) {
  const value = metadata?.opencodezPromptTurn
  if (!Schema.is(Turn)(value) || value.turnID !== turnID) return undefined
  return value
}

export async function captureTurn(input: {
  turnID: string
  metadata?: Record<string, unknown>
  config: OpenCodezSettings.ConfigLike
  model: OpenCodezSettings.ModelLike
  sessionID: string
}) {
  const previous = turnSnapshot(input.metadata, input.turnID)
  if (previous) return previous
  await ensureDefaults()
  const selection = OpenCodezSession.effective(input)
  const text = selection.system ? await readPrompt(selection.system) : undefined
  if (selection.system && text === undefined)
    OpenCodezPromptStore.fail("missing", "Selected System prompt is unavailable")
  return { turnID: input.turnID, prompt: selection.system, text, disabled: selection.systemManual && !selection.system }
}

export function helpText() {
  const dirs = directories()
  return [
    "System prompts:",
    `  ${dirs.system}/`,
    "  Model instructions and custom system prompts.",
    "",
    "Model defaults:",
    `  ${dirs.config}`,
    "  Where model-specific default System prompts are configured.",
    "",
    "Names come from filenames without extensions.",
  ].join("\n")
}

const legacyHashes: Record<string, string> = {
  "codex_gpt_5_2.md": "c9b2fa097ac69cae82c3d2ae12271083890a96521c55ad8dc14cae5168ad3f39",
  "codex_gpt_5_2_codex.md": "a8b5587d46c06d2748b935d48c1b5a8b686429dda932f6280a4e291a792696c4",
  "codex_gpt_5_3_codex.md": "77f4ad48f22cb727fc968fb64672334109bce8077d3662d5e0b45abf2669e78e",
  "codex_gpt_5_4.md": "a3e62c34ca3d50e4e56be6574fa2ef7b7b2f3f80da245881bcaa130bb056bc59",
  "codex_gpt_5_4_mini.md": "1d4d6bd1590a85b53efe59e511db8be839905a95786689f8db9c0b0b284aa39b",
  "codex_gpt_5_5.md": "f58a70533110f7272227c73b8fe26ddec9b315a5cce7e2964b216b6de074e362",
  "codex_gpt_5_6_luna_terra.md": "3aeec1d261e8f8345f8243b233a17f95fa7a6d0f7e6693f3cede952481cafab6",
  "codex_gpt_5_6_sol.md": "556d9e9c911b0c53081acabc92d3cc285dc64e230213cc60d49f15056881ebe2",
}

async function removeLegacyCopies(targetDir: string) {
  const files = await fs.readdir(targetDir).catch(() => [])
  await Promise.all(
    files.flatMap((file) => {
      const expected = legacyHashes[file]
      if (!expected) return []
      const target = path.join(targetDir, file)
      return [
        fs
          .readFile(target)
          .then(async (content) => {
            const actual = new Bun.CryptoHasher("sha256").update(content).digest("hex")
            if (actual === expected) await fs.unlink(target)
          })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
          }),
      ]
    }),
  )
}
