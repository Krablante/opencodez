import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { Auth } from "@/auth"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { OpenCodezResponsesCompact } from "@/opencodez/responses-compact"
import { OpenCodezResponsesCompaction } from "@/opencodez/responses-compaction"
import { SystemPrompt } from "./system"
import { Usage } from "@opencode-ai/llm"
import type { TaskPromptOps } from "@/tool/task"
import { SessionModelContext } from "./model-context"
import { LLMRequestPrep } from "./llm/request"
import { Instruction } from "./instruction"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { errorMessage } from "@/util/error"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000
// Keep one overall operation deadline above the bounded transport retry budget.
// Each streamed attempt still uses the WebSocket pool's five-minute idle limit.
const REMOTE_COMPACTION_TIMEOUT_MS = 20 * 60_000
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

type Phase = NonNullable<SessionV1.CompactionPart["phase"]>

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
    additionalTokens?: number
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    phase?: Phase
    overflow?: boolean
    abort?: AbortSignal
    prepared?: LLMRequestPrep.Prepared
    promptOps?: TaskPromptOps
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    phase?: Phase
    turnID?: MessageID
    overflow?: boolean
  }) => Effect.Effect<void>
  readonly capturePending: (input: { sessionID: SessionID; messages: SessionV1.WithParts[] }) => Effect.Effect<boolean>
  readonly releasePending: (input: { sessionID: SessionID }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const auth = yield* Auth.Service
    const instruction = yield* Instruction.Service
    const system = yield* SystemPrompt.Service
    const permission = yield* Permission.Service
    const registry = yield* ToolRegistry.Service
    const mcp = yield* MCP.Service
    const truncate = yield* Truncate.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
      additionalTokens?: number
    }) {
      const cfg = yield* config.get()
      const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)
      let limit: number | undefined
      if (input.model.providerID === "openai" && authInfo?.type === "oauth") {
        limit = OpenCodezSettings.responsesCompactionLimit(cfg, input.model.limit)
      }
      return overflow({
        cfg,
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
        limit,
        additionalTokens: input.additionalTokens,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const replayUser = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      message: { info: SessionV1.User; parts: SessionV1.Part[] }
      replaceMedia: boolean
    }) {
      const original = input.message.info
      const replay = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: original.agent,
        model: original.model,
        format: original.format,
        tools: original.tools,
        system: original.system,
      })
      for (const part of input.message.parts) {
        if (part.type === "compaction") continue
        const next =
          input.replaceMedia && part.type === "file" && MessageV2.isMedia(part.mime)
            ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
            : part
        yield* session.updatePart({
          ...next,
          id: PartID.ascending(),
          messageID: replay.id,
          sessionID: input.sessionID,
        })
      }
    })

    const pendingUsers = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      turnID: MessageID
      markerID: MessageID
    }) {
      return (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie))
        .filter(
          (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
            message.info.role === "user" &&
            message.info.id > input.turnID &&
            message.info.id !== input.markerID &&
            !message.parts.some((part) => part.type === "compaction"),
        )
        .toSorted((a, b) => a.info.id.localeCompare(b.info.id))
    })

    const completeCompaction = Effect.fn("SessionCompaction.complete")(function* (input: {
      sessionID: SessionID
      userMessage: SessionV1.User
      replay?: { info: SessionV1.User; parts: SessionV1.Part[] }
      result: "continue" | "stop"
      auto: boolean
      phase?: Phase
      direct?: boolean
      overflow?: boolean
      replaceReplayMedia?: boolean
    }) {
      if (input.result === "continue" && input.auto) {
        if (input.replay) {
          yield* replayUser({
            sessionID: input.sessionID,
            message: input.replay,
            replaceMedia: input.replaceReplayMedia ?? true,
          })
        }

        if (!input.replay && !input.direct) {
          const info = yield* provider.getProvider(input.userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: input.userMessage.agent,
                model: yield* provider
                  .getModel(input.userMessage.model.providerID, input.userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: input.userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: input.userMessage.agent,
              model: input.userMessage.model,
            })
            const text =
              (input.overflow && input.phase !== "mid-turn"
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (input.result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return input.result
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      phase?: Phase
      overflow?: boolean
      abort?: AbortSignal
      prepared?: LLMRequestPrep.Prepared
      promptOps?: TaskPromptOps
    }) {
      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      // Markers created before phases were persisted used overflow=true for
      // pre-turn recovery. Keep those sessions resumable while making new
      // mid-turn compaction preserve the complete in-flight turn.
      const phase = input.phase ?? (input.overflow ? "pre-turn" : undefined)
      if (phase === "pre-turn") {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay &&
          messages.some(
            (m) =>
              m.info.role === "user" &&
              (!m.parts.some((p) => p.type === "compaction") ||
                m.parts.some((p) => p.type === "compaction" && p.remote?.providerID === "openai")),
          )
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const turnID = compactionPart?.turn_id
      const pending =
        phase === "mid-turn" && turnID
          ? input.messages.filter(
              (message) =>
                message.info.role === "user" &&
                message.info.id > turnID &&
                message.info.id !== input.parentID &&
                !message.parts.some((part) => part.type === "compaction"),
            )
          : []
      if (pending.length > 0) {
        const pendingIDs = new Set(pending.map((message) => message.info.id))
        messages = messages.filter(
          (message) =>
            !pendingIDs.has(message.info.id) &&
            !(message.info.role === "assistant" && pendingIDs.has(message.info.parentID)),
        )
        const firstPending = pending.toSorted((a, b) => a.info.id.localeCompare(b.info.id))[0]
        if (compactionPart && firstPending) {
          yield* session.updatePart({ ...compactionPart, tail_start_id: firstPending.info.id })
        }
      }

      const cfg = yield* config.get()
      const history = compactionPart ? messages.filter((message) => message.info.id !== input.parentID) : messages
      const sourceModel = yield* provider
        .getModel(userMessage.model.providerID, userMessage.model.modelID)
        .pipe(Effect.orDie)
      const authInfo = yield* auth.get(userMessage.model.providerID).pipe(Effect.orDie)
      const remote = sourceModel.providerID === "openai" && authInfo?.type === "oauth"

      if (remote) {
        if (!compactionPart) throw new Error(`Missing compaction part for ${input.parentID}`)
        if (!input.promptOps) throw new Error(`Missing prompt operations for remote compaction ${input.parentID}`)
        const promptOps = input.promptOps
        const ctx = yield* InstanceState.context
        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: input.parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: sourceModel.id,
          providerID: sourceModel.providerID,
          time: { created: Date.now() },
        }
        yield* session.updateMessage(msg)
        yield* events.publish(MessageV2.Event.Updated, { sessionID: input.sessionID, info: msg })

        yield* Effect.logInfo("remote compaction", {
          "session.id": input.sessionID,
          phase: phase ?? "manual",
          messages: history.length,
        })
        const compacted = yield* Effect.gen(function* () {
          const requestUser =
            input.messages.find(
              (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
                message.info.role === "user" && message.info.id === turnID,
            )?.info ??
            replay?.info ??
            input.messages.findLast(
              (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
                message.info.role === "user" && !message.parts.some((part) => part.type === "compaction"),
            )?.info
          if (!requestUser) throw new Error(`Missing request user for compaction ${input.parentID}`)
          const requestAgent = yield* agents.get(requestUser.agent)
          if (!requestAgent) throw new Error(`Agent not found for compaction: ${requestUser.agent}`)
          const sessionInfo = yield* session.get(input.sessionID).pipe(Effect.orDie)
          const active = OpenCodezResponsesCompaction.tail(history)
          const providerInfo = yield* provider.getProvider(sourceModel.providerID)
          const snapshot = input.prepared
          const prepared = snapshot
            ? yield* Effect.gen(function* () {
                if (phase === "mid-turn" && input.overflow && pending.length === 0) return snapshot
                const messages = structuredClone(active.messages)
                yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages })
                return {
                  ...snapshot,
                  messages: yield* MessageV2.toModelMessagesEffect(messages, sourceModel),
                }
              })
            : yield* Effect.gen(function* () {
                const context = yield* SessionModelContext.resolve({
                  agent: requestAgent,
                  model: sourceModel,
                  session: sessionInfo,
                  messages: structuredClone(active.messages),
                  promptOps,
                }).pipe(
                  Effect.provideService(Plugin.Service, plugin),
                  Effect.provideService(Permission.Service, permission),
                  Effect.provideService(ToolRegistry.Service, registry),
                  Effect.provideService(MCP.Service, mcp),
                  Effect.provideService(Truncate.Service, truncate),
                  Effect.provideService(RuntimeFlags.Service, flags),
                  Effect.provideService(Instruction.Service, instruction),
                  Effect.provideService(SystemPrompt.Service, system),
                )
                return yield* LLMRequestPrep.prepare({
                  user: requestUser,
                  turnID: phase === "mid-turn" ? turnID : undefined,
                  sessionID: input.sessionID,
                  parentSessionID: sessionInfo.parentID,
                  sessionMetadata: OpenCodezResponsesCompaction.withMetadata(sessionInfo.metadata, history),
                  model: sourceModel,
                  agent: requestAgent,
                  permission: sessionInfo.permission,
                  system: context.system,
                  messages: context.messages,
                  tools: context.tools,
                  provider: providerInfo,
                  auth: authInfo,
                  plugin,
                  flags,
                  isWorkflow: false,
                  config: cfg,
                })
              })
          return yield* OpenCodezResponsesCompact.compact({
            model: sourceModel,
            provider: providerInfo,
            system: prepared.system,
            messages: prepared.messages,
            tools: prepared.tools,
            options: prepared.params.options,
            items: active.items,
            sessionID: input.sessionID,
            turnID: phase === "mid-turn" ? turnID : undefined,
            preserveActiveToolMedia: phase === "mid-turn",
            abort: input.abort ?? AbortSignal.timeout(REMOTE_COMPACTION_TIMEOUT_MS),
          })
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          }),
        )

        if (!compacted.ok) {
          yield* Effect.logError("remote compaction failed", {
            "session.id": input.sessionID,
            phase: phase ?? "manual",
            error: errorMessage(compacted.error),
          })
          msg.error = MessageV2.fromError(compacted.error, { providerID: sourceModel.providerID })
          msg.finish = "error"
          msg.time.completed = Date.now()
          yield* session.updateMessage(msg)
          return "stop"
        }
        if (compacted.value.trimmedOutputs > 0) {
          yield* Effect.logInfo("trimmed remote compaction tool outputs", {
            "session.id": input.sessionID,
            count: compacted.value.trimmedOutputs,
          })
        }

        const currentPart = yield* session.getPart({
          sessionID: input.sessionID,
          messageID: compactionPart.messageID,
          partID: compactionPart.id,
        })
        const discoveredPending = turnID
          ? yield* pendingUsers({ sessionID: input.sessionID, turnID, markerID: input.parentID })
          : []
        yield* session.updatePart({
          ...compactionPart,
          ...(currentPart?.type === "compaction" && currentPart.tail_start_id
            ? { tail_start_id: currentPart.tail_start_id }
            : discoveredPending[0]
              ? { tail_start_id: discoveredPending[0].info.id }
              : {}),
          remote: {
            providerID: "openai",
            items: compacted.value.items,
            model_id: sourceModel.api.id,
            account_key:
              authInfo?.type === "oauth"
                ? OpenCodezResponsesCompaction.accountKey(authInfo.accountId, authInfo.access)
                : undefined,
          },
        })
        const usage = Session.getUsage({
          model: sourceModel,
          usage: new Usage({
            totalTokens: compacted.value.usage.total,
            inputTokens: compacted.value.usage.input,
            outputTokens: compacted.value.usage.output,
            reasoningTokens: compacted.value.usage.reasoning,
          }),
        })
        msg.cost = usage.cost
        msg.tokens = usage.tokens
        msg.finish = "stop"
        msg.time.completed = Date.now()
        yield* session.updateMessage(msg)
        return yield* completeCompaction({
          sessionID: input.sessionID,
          userMessage,
          replay,
          result: "continue",
          auto: input.auto,
          phase,
          direct: phase === "mid-turn",
          overflow: input.overflow,
          replaceReplayMedia: false,
        })
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : sourceModel
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (processor.message.error) return "stop"
      return yield* completeCompaction({
        sessionID: input.sessionID,
        userMessage,
        replay,
        result,
        auto: input.auto,
        phase,
        overflow: input.overflow,
      })
    })

    const capturePending = Effect.fn("SessionCompaction.capturePending")(function* (input: {
      sessionID: SessionID
      messages: SessionV1.WithParts[]
    }) {
      const marker = input.messages.findLast(
        (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
          message.info.role === "user" &&
          message.parts.some(
            (part) =>
              part.type === "compaction" &&
              part.phase === "mid-turn" &&
              part.remote?.providerID === "openai" &&
              part.turn_id !== undefined,
          ),
      )
      const part = marker?.parts.find(
        (item): item is SessionV1.CompactionPart =>
          item.type === "compaction" &&
          item.phase === "mid-turn" &&
          item.remote?.providerID === "openai" &&
          item.turn_id !== undefined,
      )
      if (!marker || !part?.turn_id || part.tail_start_id) return false
      const summary = input.messages.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.summary === true &&
          message.info.parentID === marker.info.id &&
          message.info.finish !== undefined,
      )
      const continuation = summary
        ? input.messages.find(
            (message) =>
              message.info.role === "assistant" &&
              message.info.summary !== true &&
              message.info.parentID === marker.info.id &&
              message.info.id > summary.info.id,
          )
        : undefined
      if (!summary || continuation) return false
      const pending = yield* pendingUsers({
        sessionID: input.sessionID,
        turnID: part.turn_id,
        markerID: marker.info.id,
      })
      if (!pending[0]) return false
      yield* session.updatePart({ ...part, tail_start_id: pending[0].info.id })
      return true
    })

    const releasePending = Effect.fn("SessionCompaction.releasePending")(function* (input: { sessionID: SessionID }) {
      const messages = (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).toSorted((a, b) =>
        a.info.id.localeCompare(b.info.id),
      )
      const marker = messages.findLast(
        (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
          message.info.role === "user" &&
          message.parts.some(
            (part) =>
              part.type === "compaction" &&
              part.phase === "mid-turn" &&
              part.remote?.providerID === "openai" &&
              part.tail_start_id !== undefined,
          ),
      )
      const part = marker?.parts.find(
        (item): item is SessionV1.CompactionPart =>
          item.type === "compaction" &&
          item.phase === "mid-turn" &&
          item.remote?.providerID === "openai" &&
          item.tail_start_id !== undefined,
      )
      if (!marker || !part?.turn_id) return
      const summary = messages.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.summary === true &&
          message.info.parentID === marker.info.id &&
          message.info.finish !== undefined,
      )
      if (!summary) return
      const continuation = messages.find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.summary !== true &&
          message.info.parentID === marker.info.id &&
          message.info.id > summary.info.id &&
          message.info.time.completed !== undefined,
      )
      if (!continuation) return

      const pending = yield* pendingUsers({
        sessionID: input.sessionID,
        turnID: part.turn_id,
        markerID: marker.info.id,
      })
      for (const message of pending) {
        yield* replayUser({ sessionID: input.sessionID, message, replaceMedia: false })
      }
      for (const message of pending) {
        if (message.info.id > marker.info.id) {
          yield* session.removeMessage({ sessionID: input.sessionID, messageID: message.info.id })
        }
      }
      yield* session.updatePart({ ...part, tail_start_id: undefined })
      yield* Effect.logInfo("released pending input after remote compaction", {
        "session.id": input.sessionID,
        count: pending.length,
      })
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      phase?: Phase
      turnID?: MessageID
      overflow?: boolean
    }) {
      const source = input.turnID
        ? Option.getOrUndefined(
            yield* session
              .findMessage(input.sessionID, (message) => message.info.id === input.turnID)
              .pipe(Effect.orDie),
          )
        : undefined
      const turn = source?.info.role === "user" ? source.info : undefined
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.auto && turn ? turn.model : input.model,
        sessionID: input.sessionID,
        agent: turn?.agent ?? input.agent,
        format: turn?.format,
        tools: turn?.tools,
        system: turn?.system,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        phase: input.phase,
        turn_id: input.turnID,
        overflow: input.overflow,
      })
      for (const part of source?.parts ?? []) {
        if (part.type !== "agent") continue
        yield* session.updatePart({
          ...part,
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: msg.sessionID,
        })
      }
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
      capturePending,
      releasePending,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    Auth.node,
    Instruction.node,
    SystemPrompt.node,
    Permission.node,
    ToolRegistry.node,
    MCP.node,
    Truncate.node,
  ],
})

export * as SessionCompaction from "./compaction"
