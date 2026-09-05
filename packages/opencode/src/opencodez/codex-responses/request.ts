import { CodexResponsesCompaction } from "./compaction"
import { CodexResponsesCatalog } from "./catalog"
import { CodexResponsesProtocol } from "./protocol"

export function lower(
  body: BodyInit | null | undefined,
  handoff: string | undefined,
  responsesLiteEnabled: boolean,
  headers: Headers,
  accountKey?: string,
  catalog?: CodexResponsesCatalog.Snapshot,
  turnProfile?: CodexResponsesCatalog.Profile,
) {
  if (typeof body !== "string") throw new Error("OpenAI Responses request body must be JSON text")
  const value: unknown = JSON.parse(body)
  if (!isRecord(value) || !Array.isArray(value.input)) throw new Error("OpenAI Responses input must be an array")

  const profile =
    typeof value.model === "string" && turnProfile?.modelID === value.model
      ? turnProfile
      : typeof value.model === "string"
        ? CodexResponsesCatalog.resolveID(value.model, accountKey, catalog)
        : undefined
  const responsesLite = responsesLiteEnabled && profile?.responsesLite === true
  const input = responsesLite
    ? liteInput(
        value.input,
        value.tools,
        value.instructions,
        headers.get("x-session-affinity") ?? headers.get("session-id") ?? undefined,
      )
    : value.input
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
  const routingHint =
    typeof value.model === "string"
      ? `model=${value.model}${typeof value.service_tier === "string" ? `;tier=${value.service_tier}` : ""}`
      : undefined
  return { body: JSON.stringify(CodexResponsesProtocol.enrich(result, headers)), responsesLite, routingHint }
}

function liteInput(input: unknown[], tools: unknown, instructions: unknown, threadID: string | undefined) {
  stripImageDetails(input)
  const namespacedTools = namespaceTools(Array.isArray(tools) ? tools : [])
  const namespace = threadID ? uuidV5("6ba7b812-9dad-11d1-80b4-00c04fd430c8", threadID) : undefined
  return [
    {
      type: "additional_tools",
      ...(namespace ? { id: `at_${uuidV5(namespace, JSON.stringify(namespacedTools))}` } : {}),
      role: "developer",
      tools: namespacedTools,
    },
    ...(typeof instructions === "string" && instructions
      ? [
          {
            type: "message",
            ...(namespace ? { id: `msg_${uuidV5(namespace, instructions)}` } : {}),
            role: "developer",
            content: [{ type: "input_text", text: instructions }],
          },
        ]
      : []),
    ...input,
  ]
}

function namespaceTools(tools: unknown[]) {
  const direct = tools.filter((tool) => isRecord(tool) && (tool.type === "function" || tool.type === "custom"))
  if (direct.length === 0) return tools
  const directSet = new Set(direct)
  const first = tools.findIndex((tool) => directSet.has(tool))
  return [
    ...tools.slice(0, first).filter((tool) => !directSet.has(tool)),
    { type: "namespace", name: "functions", description: "", tools: direct },
    ...tools.slice(first).filter((tool) => !directSet.has(tool)),
  ]
}

function uuidV5(namespace: string, value: string) {
  const digest = new Bun.CryptoHasher("sha1")
    .update(Buffer.concat([Buffer.from(namespace.replaceAll("-", ""), "hex"), Buffer.from(value)]))
    .digest()
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
