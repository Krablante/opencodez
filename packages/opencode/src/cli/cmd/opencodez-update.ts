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
    const result = await OpenCodezUpdate.run({ check, current: InstallationVersion })
    UI.println(result.message)
    if (result.status === "error" || (!check && result.status === "unavailable")) process.exit(1)
  },
}

export const OpenCodezUpgradeCommand: CommandModule = {
  command: "upgrade",
  describe: false,
  handler: async () => {
    UI.println("OpenCodez uses GitHub Releases for updates. Run `opencodez update` or `opencodez update --check`.")
  },
}
