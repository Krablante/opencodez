import { CodexResponsesCompaction } from "./compaction"
import { CodexResponsesCatalog } from "./catalog"
import { CodexResponsesProtocol } from "./protocol"

export function lower(
  body: BodyInit | null | undefined,
  handoff: string | undefined,
  responsesLiteEnabled: boolean,
  headers: Headers,
  accountKey?: string,
) {
  if (typeof body !== "string") throw new Error("OpenAI Responses request body must be JSON text")
  const value: unknown = JSON.parse(body)
  if (!isRecord(value) || !Array.isArray(value.input)) throw new Error("OpenAI Responses input must be an array")

  const profile = typeof value.model === "string" ? CodexResponsesCatalog.resolveID(value.model, accountKey) : undefined
  const responsesLite = responsesLiteEnabled && profile?.responsesLite === true
  const input = responsesLite ? liteInput(value.input, value.tools, value.instructions) : value.input
  const context = handoff ? CodexResponsesCompaction.consume(handoff) : undefined
  if (context && profile?.compHash && context.compHash !== profile.compHash) {
    throw new Error("This session's OpenAI compacted state belongs to an older backend snapshot")
  }
  const merged = context ? inject(input, context.items) : removeContinueMarker(input)
  const result: Record<string, unknown> = { ...value, input: merged }
  if (responsesLite) {
    result.instructions = ""
    delete result.tools
    result.parallel_tool_calls = false
    result.reasoning = { ...(isRecord(result.reasoning) ? result.reasoning : {}), context: "all_turns" }
    result.client_metadata = {
      ...(isRecord(result.client_metadata) ? result.client_metadata : {}),
      [CodexResponsesCatalog.RESPONSES_LITE_METADATA]: "true",
    }
  }
  return { body: JSON.stringify(CodexResponsesProtocol.enrich(result, headers)), responsesLite }
}

function liteInput(input: unknown[], tools: unknown, instructions: unknown) {
  stripImageDetails(input)
  return [
    { type: "additional_tools", role: "developer", tools: Array.isArray(tools) ? tools : [] },
    ...(typeof instructions === "string" && instructions
      ? [{ type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] }]
      : []),
    ...input,
  ]
}

function inject(input: unknown[], items: unknown[]) {
  const split = input.findIndex((item) => !isRequestPrefix(item))
  const index = split === -1 ? input.length : split
  return [
    ...input.slice(0, index),
    ...items.filter((item) => !isRequestPrefix(item)),
    ...removeContinueMarker(input.slice(index)),
  ]
}

function removeContinueMarker(input: unknown[]) {
  return input.filter((item) => !isContinueMarker(item))
}

function isRequestPrefix(value: unknown) {
  return isRecord(value) && (value.type === "additional_tools" || value.role === "system" || value.role === "developer")
}

function isContinueMarker(value: unknown) {
  if (!isRecord(value) || value.role !== "user" || !Array.isArray(value.content) || value.content.length !== 1)
    return false
  const content = value.content[0]
  return isRecord(content) && content.type === "input_text" && content.text === CodexResponsesCompaction.CONTINUE_MARKER
}

function stripImageDetails(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(stripImageDetails)
    return
  }
  if (!isRecord(value)) return
  if (value.type === "input_image") delete value.detail
  Object.values(value).forEach(stripImageDetails)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export * as CodexResponsesRequest from "./request"
