import { Glob } from "@opencode-ai/core/util/glob"
import type { ModelMessage } from "ai"

export * as OpenCodezContextPrune from "./context-prune"

type Settings = {
  enabled: boolean
  pruning_size: number
  preserve_tools: string[]
  prune: {
    reasoning: boolean
    tool: boolean
  }
}

type Eligible = {
  message: number
  part: number
  kind: "reasoning" | "tool-result"
  chars: number
}

export function apply(input: { messages: ModelMessage[]; settings: Settings }): ModelMessage[] {
  if (!input.settings.enabled) return input.messages

  const eligible: Eligible[] = []
  input.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return
    ;(message.content as unknown[]).forEach((part, partIndex) => {
      if (!isRecord(part)) return
      if (part.type === "reasoning" && input.settings.prune.reasoning) {
        const chars = textPayload(part).length
        if (chars > 0) eligible.push({ message: messageIndex, part: partIndex, kind: "reasoning", chars })
        return
      }
      if (part.type === "tool-result" && input.settings.prune.tool) {
        const toolName = typeof part.toolName === "string" ? part.toolName : ""
        if (isPreserved(toolName, input.settings.preserve_tools)) return
        const chars = toolPayload(part).length
        if (chars > 0) eligible.push({ message: messageIndex, part: partIndex, kind: "tool-result", chars })
      }
    })
  })

  const prune = new Set<string>()
  let used = 0
  for (let index = eligible.length - 1; index >= 0; index--) {
    const item = eligible[index]
    if (input.settings.pruning_size === 0 || used + item.chars > input.settings.pruning_size) {
      prune.add(key(item))
      continue
    }
    used += item.chars
  }
  if (prune.size === 0) return input.messages

  return input.messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = (message.content as unknown[]).map((part, partIndex) => {
      const item = eligible.find((entry) => entry.message === messageIndex && entry.part === partIndex)
      if (!item || !prune.has(key(item)) || !isRecord(part)) return part
      changed = true
      if (item.kind === "reasoning") {
        return {
          ...part,
          text: `[reasoning pruned: ${item.chars} chars]`,
        }
      }
      return {
        ...part,
        output: {
          type: "text",
          value: `[Tool output pruned: ${item.chars} chars]`,
        },
      }
    })
    return changed ? { ...message, content } : message
  }) as ModelMessage[]
}

function key(item: Pick<Eligible, "message" | "part">) {
  return `${item.message}:${item.part}`
}

function isPreserved(toolName: string, patterns: string[]) {
  return patterns.some((pattern) => {
    if (pattern === toolName) return true
    try {
      return Glob.match(pattern, toolName)
    } catch {
      return false
    }
  })
}

function textPayload(part: Record<string, unknown>) {
  return typeof part.text === "string" ? part.text : ""
}

function toolPayload(part: Record<string, unknown>) {
  const output = isRecord(part.output) && "value" in part.output ? part.output.value : part.output
  if (typeof output === "string") return output
  try {
    return JSON.stringify(output) ?? ""
  } catch {
    return String(output ?? "")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
