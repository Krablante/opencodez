import { Global } from "@opencode-ai/core/global"
import type { Argv, CommandModule } from "yargs"
import * as UI from "../ui"

export const OpenCodezUninstallCommand: CommandModule<
  Record<string, unknown>,
  {
    keepConfig?: boolean
    keepData?: boolean
    dryRun?: boolean
    force?: boolean
  }
> = {
  command: "uninstall",
  describe: "show how to remove OpenCodez without touching upstream OpenCode",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "accepted for compatibility; OpenCodez uninstall is manual",
        default: false,
      }),
  handler: async () => {
    UI.println("OpenCodez does not uninstall upstream OpenCode or opencode-ai packages.")
    UI.println("Remove the opencodez binary from your install directory, then remove OpenCodez state if desired:")
    UI.println(`  config: ${Global.Path.config}`)
    UI.println(`  data:   ${Global.Path.data}`)
    UI.println(`  cache:  ${Global.Path.cache}`)
    UI.println(`  state:  ${Global.Path.state}`)
  },
}
