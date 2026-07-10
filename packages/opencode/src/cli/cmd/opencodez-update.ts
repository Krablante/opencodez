import type { Argv, CommandModule } from "yargs"
import * as UI from "../ui"
import { OpenCodezUpdate } from "../../opencodez/update"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export const OpenCodezUpdateCommand: CommandModule<Record<string, unknown>, { check?: boolean }> = {
  command: "update",
  describe: "update OpenCodez from GitHub Releases",
  builder: (yargs: Argv) =>
    yargs.option("check", {
      type: "boolean",
      describe: "check for an available OpenCodez release without installing it",
      default: false,
    }),
  handler: async (args: { check?: boolean }) => {
    const check = args.check === true
    const progress = createProgressReporter()
    const result = await OpenCodezUpdate.run({
      check,
      current: InstallationVersion,
      onEvent: (event) => progress.onEvent(event),
    })
    progress.finish()
    UI.println(result.message)
    if (result.status === "error" || (!check && result.status === "unavailable")) process.exit(1)
  },
}

function createProgressReporter() {
  let progressLine = false
  let lastProgressAt = 0

  function finish() {
    if (!progressLine) return
    UI.print("\n")
    progressLine = false
  }

  function writeProgress(line: string, force = false) {
    const now = Date.now()
    if (!force && now - lastProgressAt < 100) return
    lastProgressAt = now
    if (process.stderr.isTTY) {
      UI.print(`\r${line}\x1b[K`)
      progressLine = true
      return
    }
    UI.println(line)
  }

  return {
    finish,
    onEvent(event: OpenCodezUpdate.UpdateEvent) {
      switch (event.type) {
        case "checking":
          finish()
          UI.println("Checking GitHub Releases...")
          break
        case "latest":
          finish()
          UI.println(`Latest release: ${event.tag}`)
          break
        case "download-start":
          finish()
          writeProgress(renderDownloadProgress(event.asset, 0, event.totalBytes), true)
          break
        case "download-progress":
          writeProgress(
            renderDownloadProgress(event.asset, event.downloadedBytes, event.totalBytes),
            event.totalBytes !== undefined && event.downloadedBytes >= event.totalBytes,
          )
          break
        case "installing":
          finish()
          UI.println(`Installing ${event.asset}...`)
          break
      }
    },
  }
}

function renderDownloadProgress(asset: string, downloadedBytes: number, totalBytes: number | undefined) {
  if (totalBytes === undefined) return `Downloading ${asset}: ${formatMegabytes(downloadedBytes)}`
  const percent = totalBytes === 0 ? 100 : Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100))
  return `Downloading ${asset}: ${formatMegabytes(downloadedBytes)} / ${formatMegabytes(totalBytes)} ${percent}%`
}

function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export const OpenCodezUpgradeCommand: CommandModule = {
  command: "upgrade",
  describe: false,
  handler: async () => {
    UI.println("OpenCodez uses GitHub Releases for updates. Run `opencodez update` or `opencodez update --check`.")
  },
}
