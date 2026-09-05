export * as OpenCodezPromptLibrary from "./prompt-library"

import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
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
  await removeLegacyCopies(dirs.system)
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
  return Array.from(new Map([...builtin, ...bundled, ...library].map((item) => [item.name, item])).values()).sort(
    (a, b) => a.name.localeCompare(b.name),
  )
}

export async function get(name: string) {
  const entry = (await list()).find((item) => item.name === name)
  if (!entry) return undefined
  return entry
}

export async function readPrompt(name: string) {
  const entry = await get(name)
  if (!entry) return undefined
  if (entry.source === "library") return Bun.file(entry.path).text()
  const bundled = (defaultPromptAssets.core as Record<string, string>)[`${name}.md`]
  return bundled ?? SystemPrompt.builtinPrompt(name)
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
