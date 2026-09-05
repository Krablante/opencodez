/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import { OpenCodezIdentity } from "../opencodez/identity"

export const CustomizeOpencodeContent = customizeOpencodeContent
  .replaceAll("{{PRODUCT_NAME}}", OpenCodezIdentity.productName)
  .replaceAll("{{CLI_NAME}}", OpenCodezIdentity.cliName)
  .replaceAll("{{GLOBAL_CONFIG_ROOT}}", OpenCodezIdentity.globalConfigDirectory)
export const CustomizeOpencodeDescription = `Use ONLY when the user is editing or creating ${OpenCodezIdentity.productName}'s own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ${OpenCodezIdentity.globalConfigDirectory}/. Also use when creating or fixing ${OpenCodezIdentity.productName} agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring ${OpenCodezIdentity.productName} itself.`

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode",
            description: CustomizeOpencodeDescription,
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
