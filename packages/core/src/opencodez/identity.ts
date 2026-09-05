export * as OpenCodezIdentity from "./identity"

const invokedAsOpenCodez = [process.argv[0], process.argv[1], process.execPath]
  .filter((item): item is string => typeof item === "string")
  .some((item) => {
    const lower = item.toLowerCase()
    return lower.endsWith("/opencodez") || lower.endsWith("\\opencodez.exe") || lower.endsWith("/opencodez.exe")
  })

export const enabled =
  process.env["OPENCODE_APP_NAME"] === "opencodez" ||
  process.env["OPENCODE_CLI_NAME"] === "opencodez" ||
  process.env["OPENCODEZ"] === "1" ||
  invokedAsOpenCodez

export const cliName = process.env["OPENCODE_CLI_NAME"] || (enabled ? "opencodez" : "opencode")
export const appName = process.env["OPENCODE_APP_NAME"] || (enabled ? "opencodez" : "opencode")
export const productName = enabled ? "OpenCodez" : "OpenCode"
export const globalConfigDirectory = `~/.config/${appName}`
