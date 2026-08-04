export const HEADER = "x-opencodez-codex-responses"
export const OFFICIAL_ADAPTER = "@ai-sdk/openai"

export type Wire = "legacy" | "codex"

export function supportsModel(input: { providerID: string; modelNpm: string; wire: Wire }) {
  return input.providerID === "openai" && input.modelNpm === OFFICIAL_ADAPTER && input.wire === "codex"
}

export function enabled(input: { providerID: string; modelNpm: string; authType?: string; wire: Wire }) {
  return supportsModel(input) && input.authType === "oauth"
}

export * as CodexResponsesCapability from "./capability"
