export * as OpenCodezSlash from "./slash"

export type Command =
  | { type: "system"; name?: string }
  | { type: "tone"; name?: string }
  | { type: "template"; name?: string }
  | { type: "prompts" }
  | { type: "new"; system?: string; tone?: string; template?: string; error?: string }
  | { type: "pruning"; action?: "on" | "off" | "size"; size?: number; error?: string }

export function parse(input: string): Command | undefined {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return
  const args = split(trimmed)
  if (args.length === 0) return
  const [head, ...rest] = args
  switch (head) {
    case "/system":
      return { type: "system", name: rest[0] }
    case "/tone":
      return { type: "tone", name: rest[0] }
    case "/template":
      return { type: "template", name: rest[0] }
    case "/prompts":
      return { type: "prompts" }
    case "/new":
      return parseNew(rest)
    case "/pruning":
      return parsePruning(rest)
    default:
      return
  }
}

function parseNew(args: string[]): Command {
  let system: string | undefined
  let tone: string | undefined
  let template: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const value = args[index + 1]
    if (arg === "--system" || arg === "-s") {
      system = value
      index++
      continue
    }
    if (arg === "--tone" || arg === "-o") {
      tone = value
      index++
      continue
    }
    if (arg === "--template" || arg === "-t") {
      template = value
      index++
      continue
    }
  }
  if (template && (system || tone)) {
    return { type: "new", error: "--template cannot be combined with --system or --tone." }
  }
  return { type: "new", system, tone, template }
}

function parsePruning(args: string[]): Command {
  const [action, value] = args
  if (!action) return { type: "pruning" }
  if (action === "on" || action === "off") return { type: "pruning", action }
  if (action === "size") {
    const size = Number(value)
    if (!Number.isInteger(size) || size < 0) return { type: "pruning", error: "Expected a non-negative integer size" }
    return { type: "pruning", action: "size", size }
  }
  return { type: "pruning", error: "Expected /pruning, /pruning on, /pruning off, or /pruning size N" }
}

function split(input: string) {
  const result: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) result.push(current)
  return result
}
