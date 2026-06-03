export * as OpenCodezPromptLibrary from "./prompt-library"

import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import fs from "fs/promises"
import { parse } from "jsonc-parser"
import path from "path"
import { defaultPromptAssets } from "./default-prompts"
import { SystemPrompt } from "@/session/system"

export type Kind = "core" | "tone" | "templates"

export interface Entry {
  name: string
  path: string
  kind: Kind
  source: "builtin" | "library"
}

export interface Template {
  system: string
  tone: string
}

export function directories() {
  const config = Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config
  const root = path.join(config, "prompts")
  return {
    root,
    core: path.join(root, "core"),
    tone: path.join(root, "tone"),
    templates: path.join(root, "templates"),
    config: path.join(config, "opencode.jsonc"),
  }
}

export async function ensureDefaults() {
  const dirs = directories()
  await Promise.all([
    fs.mkdir(dirs.core, { recursive: true }),
    fs.mkdir(dirs.tone, { recursive: true }),
    fs.mkdir(dirs.templates, { recursive: true }),
  ])
  await copyMissing("core", dirs.core)
  await copyMissing("tone", dirs.tone)
  await copyMissing("templates", dirs.templates)
}

export async function list(kind: Kind): Promise<Entry[]> {
  await ensureDefaults()
  const dir = directories()[kind]
  const ext = kind === "templates" ? ".jsonc" : ".md"
  const files = await fs.readdir(dir).catch(() => [])
  const library = files
    .filter((file) => file.endsWith(ext))
    .map((file) => ({
      name: path.basename(file, ext),
      path: path.join(dir, file),
      kind,
      source: "library" as const,
    }))
  const builtin =
    kind === "core"
      ? SystemPrompt.builtinEntries().map((item) => ({
          ...item,
          kind,
          source: "builtin" as const,
        }))
      : []
  return Array.from(new Map([...builtin, ...library].map((item) => [item.name, item])).values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

export async function get(kind: Kind, name: string) {
  const entry = (await list(kind)).find((item) => item.name === name)
  if (!entry) return
  return entry
}

export async function readPrompt(kind: "core" | "tone", name: string) {
  const entry = await get(kind, name)
  if (!entry) return
  if (entry.source === "builtin" && kind === "core") return SystemPrompt.builtinPrompt(name)
  return Bun.file(entry.path).text()
}

export async function readTemplate(name: string): Promise<Template | undefined> {
  const entry = await get("templates", name)
  if (!entry) return
  const data = parse(await Bun.file(entry.path).text())
  if (!data || typeof data !== "object") return
  const template = data as Partial<Template>
  if (typeof template.system !== "string" || typeof template.tone !== "string") return
  return {
    system: template.system,
    tone: template.tone,
  }
}

export function helpText() {
  const dirs = directories()
  return [
    "Core prompts:",
    `  ${dirs.core}/`,
    "  Base system prompts.",
    "",
    "Tone presets:",
    `  ${dirs.tone}/`,
    "  Response style and working manner.",
    "",
    "Templates:",
    `  ${dirs.templates}/`,
    "  Ready-to-use System + Tone pairs.",
    "",
    "Model defaults:",
    `  ${dirs.config}`,
    "  Where model-specific default Core prompt and default Tone are configured.",
    "",
    "Names come from filenames without extensions.",
  ].join("\n")
}

async function copyMissing(kind: Kind, targetDir: string) {
  const files = Object.entries(defaultPromptAssets[kind])
  await Promise.all(
    files.map(async ([file, content]) => {
      const target = path.join(targetDir, file)
      if (await Filesystem.exists(target)) return
      await fs.writeFile(target, content)
    }),
  )
}
