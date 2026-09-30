export * as OpenCodezPromptStore from "./prompt-store"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { OpenCodezPrompts } from "@opencode-ai/schema/opencodez-prompts"
import { OpenCodezPromptPolicy } from "@opencode-ai/core/opencodez/prompt-policy"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"

const StoredEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  text: Schema.String,
  deleted: Schema.Boolean,
  origin: Schema.optional(Schema.Struct({ id: Schema.String, version: Schema.String })),
  importHash: Schema.optional(Schema.String),
})
export type StoredEntry = typeof StoredEntry.Type
const Document = Schema.Struct({
  format: Schema.Literal(1),
  revision: Schema.Int,
  entries: Schema.Array(StoredEntry),
  rules: Schema.Array(OpenCodezPrompts.Rule),
  variants: Schema.Array(OpenCodezPrompts.Variant),
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ name: Schema.String, description: Schema.String, deleted: Schema.Boolean }),
  ),
})
export type Document = typeof Document.Type

let cache: { file: string; stamp: string; document: Document } | undefined
let writing: Promise<unknown> = Promise.resolve()

export function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

export function fail(code: OpenCodezPrompts.Error["code"], message: string): never {
  throw new OpenCodezPrompts.Error({ code, message })
}

export async function read(root: string) {
  const file = path.join(root, "library.json")
  const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : "missing"
  if (cache?.file === file && cache.stamp === stamp) return cache.document
  if (stat && stat.size > 32 * 1024 * 1024) fail("invalid", "Prompt library exceeds 32 MiB")
  const document = stat
    ? Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Document)))(
        await fs.readFile(file, "utf8"),
      )
    : { format: 1 as const, revision: 0, entries: [], rules: [], variants: [], files: {} }
  cache = { file, stamp, document }
  OpenCodezPromptPolicy.install(document)
  OpenCodezSession.refresh()
  return document
}

export async function change(root: string, revision: string, update: (document: Document) => Promise<Document>) {
  const pending = writing.then(async () => {
    const current = await read(root)
    if (String(current.revision) !== revision) fail("conflict", "The library changed. Refresh before saving.")
    const next = { ...(await update(current)), revision: current.revision + 1 }
    const text = JSON.stringify(next, null, 2) + "\n"
    if (Buffer.byteLength(text) > 32 * 1024 * 1024) fail("invalid", "Prompt library exceeds 32 MiB")
    await fs.mkdir(root, { recursive: true })
    const temporary = path.join(root, `.library-${crypto.randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" })
      await fs.rename(temporary, path.join(root, "library.json"))
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
    cache = undefined
    await read(root)
    return next
  })
  writing = pending.catch(() => {})
  return pending
}

export async function writeText(file: string, text: string) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: "wx" })
    await fs.rename(temporary, file)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}
