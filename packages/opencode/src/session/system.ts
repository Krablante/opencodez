import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

const builtin = {
  anthropic: PROMPT_ANTHROPIC,
  beast: PROMPT_BEAST,
  codex: PROMPT_CODEX,
  default: PROMPT_DEFAULT,
  gemini: PROMPT_GEMINI,
  gpt: PROMPT_GPT,
  kimi: PROMPT_KIMI,
  trinity: PROMPT_TRINITY,
} as const

export function builtinEntries() {
  return Object.keys(builtin)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      path: `builtin:session/prompt/${name}.txt`,
    }))
}

export function builtinPrompt(name: string) {
  return builtin[name as keyof typeof builtin]
}

export function providerNameFromID(modelID: string) {
  if (modelID.includes("gpt-4") || modelID.includes("o1") || modelID.includes("o3")) return "beast"
  if (modelID.includes("gpt")) {
    if (modelID.includes("codex")) return "codex"
    return "gpt"
  }
  if (modelID.includes("gemini-")) return "gemini"
  if (modelID.includes("claude")) return "anthropic"
  if (modelID.toLowerCase().includes("trinity")) return "trinity"
  if (modelID.toLowerCase().includes("kimi")) return "kimi"
  return "default"
}

export function providerName(model: Provider.Model) {
  return providerNameFromID(model.api.id)
}

export function provider(model: Provider.Model) {
  return [builtinPrompt(providerName(model)) ?? PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
