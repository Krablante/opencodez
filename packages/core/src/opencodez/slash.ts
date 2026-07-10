export * as OpenCodezSlash from "./slash"

export type Command =
  | { type: "system"; name?: string }
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
    case "/pruning":
      return parsePruning(rest)
    default:
      return
  }
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
