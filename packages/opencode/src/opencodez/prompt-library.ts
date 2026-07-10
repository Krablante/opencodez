export * as OpenCodezPromptLibrary from "./prompt-library"

import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import fs from "fs/promises"
import path from "path"
import { defaultPromptAssets } from "./default-prompts"
import { SystemPrompt } from "@/session/system"

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
  await fs.mkdir(dirs.system, { recursive: true })
  await copyMissing(dirs.system)
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
  return Array.from(new Map([...builtin, ...library].map((item) => [item.name, item])).values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
}

export async function get(name: string) {
  const entry = (await list()).find((item) => item.name === name)
  if (!entry) return
  return entry
}

export async function readPrompt(name: string) {
  const entry = await get(name)
  if (!entry) return
  if (entry.source === "builtin") return SystemPrompt.builtinPrompt(name)
  return Bun.file(entry.path).text()
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

async function copyMissing(targetDir: string) {
  const files = Object.entries(defaultPromptAssets.core)
  await Promise.all(
    files.map(async ([file, content]) => {
      const target = path.join(targetDir, file)
      if (await Filesystem.exists(target)) return
      await fs.writeFile(target, content)
    }),
  )
}
