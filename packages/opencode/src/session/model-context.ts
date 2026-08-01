import type { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import type { TaskPromptOps } from "@/tool/task"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Instruction } from "./instruction"
import { MessageV2 } from "./message-v2"
import type { SessionProcessor } from "./processor"
import type { Session } from "./session"
import { SystemPrompt } from "./system"
import { SessionTools } from "./tools"

export const resolve = Effect.fn("SessionModelContext.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor?: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
}) {
  const plugin = yield* Plugin.Service
  const instruction = yield* Instruction.Service
  const system = yield* SystemPrompt.Service
  yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: input.messages })
  const [skills, environment, instructions, mcpInstructions, messages, tools] = yield* Effect.all([
    system.skills(input.agent),
    system.environment(input.model),
    instruction.system().pipe(Effect.orDie),
    system.mcp(input.agent, input.session.permission),
    MessageV2.toModelMessagesEffect(input.messages, input.model),
    SessionTools.resolve({
      agent: input.agent,
      session: input.session,
      model: input.model,
      processor: input.processor,
      bypassAgentCheck:
        input.messages
          .findLast((message) => message.info.role === "user")
          ?.parts.some((part) => part.type === "agent") ?? false,
      messages: input.messages,
      promptOps: input.promptOps,
    }),
  ])
  return {
    system: [
      ...environment,
      ...instructions,
      ...(mcpInstructions ? [mcpInstructions] : []),
      ...(skills ? [skills] : []),
    ],
    messages,
    tools,
  }
})

export * as SessionModelContext from "./model-context"
