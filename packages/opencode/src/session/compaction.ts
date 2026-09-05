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
import { usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"
import { Auth } from "@/auth"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { CodexResponsesCompaction } from "@/opencodez/codex-responses/compaction"
import { CodexResponsesCatalog } from "@/opencodez/codex-responses/catalog"
import { CodexResponsesSessionCompaction } from "@/opencodez/codex-responses/session-compaction"
import { CodexResponsesProtocol } from "@/opencodez/codex-responses/protocol"
import { SystemPrompt } from "./system"
import type { TaskPromptOps } from "@/tool/task"
import { LLMRequestPrep } from "./llm/request"
import { Instruction } from "./instruction"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
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
type ModelRef = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

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
    turn?: CodexResponsesCompaction.TurnSettings
    profile?: CodexResponsesCatalog.Profile
    serverReasoningIncluded?: boolean
    messages?: SessionV1.WithParts[]
    turnID?: MessageID
  }) => Effect.Effect<boolean>
  readonly remoteTransition: (input: {
    sessionID: SessionID
    turnID: MessageID
    messages: SessionV1.WithParts[]
    model: Provider.Model
    tokens?: SessionV1.Assistant["tokens"]
  }) => Effect.Effect<CodexResponsesSessionCompaction.RemoteTransition | undefined>
  readonly recordRemoteTurn: (input: {
    sessionID: SessionID
    turnID: MessageID
    model: Provider.Model
  }) => Effect.Effect<CodexResponsesCompaction.TurnSettings | undefined>
  readonly saveRemoteTurn: (input: {
    sessionID: SessionID
    settings: CodexResponsesCompaction.TurnSettings
  }) => Effect.Effect<void>
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
    transition?: CodexResponsesSessionCompaction.RemoteTransition
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
    const remoteCompaction = CodexResponsesSessionCompaction.make({
      session,
      agents,
      plugin,
      provider,
      events,
      flags,
      instruction,
      system,
      permission,
      registry,
      mcp,
      truncate,
      config,
      auth,
    })
    const isOverflow = remoteCompaction.isOverflow
    const saveTurnSettings = remoteCompaction.saveTurnSettings
    const recordRemoteTurn = remoteCompaction.recordRemoteTurn
    const saveRemoteTurn = remoteCompaction.saveRemoteTurn
    const remoteTransition = remoteCompaction.remoteTransition

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
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
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
      return replay
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
      compactionPart?: SessionV1.CompactionPart
    }) {
      if (input.result === "continue" && input.auto) {
        if (input.replay) {
          const replay = yield* replayUser({
            sessionID: input.sessionID,
            message: input.replay,
            replaceMedia: input.replaceReplayMedia ?? true,
          })
          if (input.compactionPart) {
            const part = yield* session.getPart({
              sessionID: input.sessionID,
              messageID: input.compactionPart.messageID,
              partID: input.compactionPart.id,
            })
            if (part?.type === "compaction") yield* session.updatePart({ ...part, replay_id: replay.id })
            if (input.compactionPart.transition) {
              const target = yield* provider
                .getModel(
                  input.compactionPart.transition.model.providerID,
                  input.compactionPart.transition.model.modelID,
                )
                .pipe(Effect.orDie)
              yield* saveTurnSettings({
                sessionID: input.sessionID,
                turnID: replay.id,
                model: input.compactionPart.transition.model,
                apiModelID: target.api.id,
                compHash: input.compactionPart.transition.comp_hash,
              })
            }
          }
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
      const turnIndex = turnID ? input.messages.findIndex((message) => message.info.id === turnID) : -1
      const pending =
        phase === "mid-turn" && turnIndex >= 0
          ? input.messages
              .slice(turnIndex + 1)
              .filter(
                (message) =>
                  message.info.role === "user" &&
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
        const firstPending = pending[0]
        if (compactionPart && firstPending) {
          yield* session.updatePart({ ...compactionPart, tail_start_id: firstPending.info.id })
        }
      }

      const cfg = yield* config.get()
      const history = compactionPart ? messages.filter((message) => message.info.id !== input.parentID) : messages
      const sourceModel = yield* provider
        .getModel(userMessage.model.providerID, userMessage.model.modelID)
        .pipe(Effect.orDie)
      const transition = compactionPart?.transition
      const targetModel = transition
        ? yield* provider.getModel(transition.model.providerID, transition.model.modelID).pipe(Effect.orDie)
        : sourceModel
      const authInfo = yield* auth.get(userMessage.model.providerID).pipe(Effect.orDie)
      const previousCompaction = CodexResponsesCompaction.latest(history)
      const codexResponses = LLMRequestPrep.isCodexResponses({
        providerID: sourceModel.providerID,
        modelNpm: sourceModel.api.npm,
        authType: authInfo?.type,
        config: cfg,
      })
      // Legacy mode creates local summaries. Existing opaque history remains on
      // the remote path so changing the setting never discards durable context.
      const remote = codexResponses || (sourceModel.providerID === "openai" && !!previousCompaction)
      const accountKey =
        authInfo?.type === "oauth" ? CodexResponsesProtocol.accountKey(authInfo.accountId, authInfo.access) : undefined
      const turnSettings = input.prepared?.codexResponsesTurn?.settings
      if (turnSettings?.accountKey && turnSettings.accountKey !== accountKey) {
        throw new Error(
          "The ChatGPT login changed during the active turn. Retry with a new message to continue safely.",
        )
      }
      const targetProfile =
        turnSettings?.profile?.modelID === targetModel.api.id
          ? turnSettings.profile
          : accountKey
            ? CodexResponsesCatalog.resolve(
                targetModel,
                accountKey,
                undefined,
                OpenCodezSettings.responsesContextWindow(cfg),
              )
            : undefined
      const remoteResult = yield* remoteCompaction.process({
        remote,
        sessionID: input.sessionID,
        parentID: input.parentID,
        messages: input.messages,
        history,
        userMessage,
        compactionPart,
        phase,
        replay,
        pending,
        auto: input.auto,
        overflow: input.overflow,
        abort: input.abort,
        prepared: input.prepared,
        promptOps: input.promptOps,
        sourceModel,
        targetModel,
        authInfo,
        accountKey,
        turnID,
        targetProfile,
        previousCompaction,
        transition,
        cfg,
        complete: completeCompaction,
      })
      if (remoteResult) return remoteResult
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
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
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
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  nextPrompt,
                  ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
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
        compactionPart,
      })
    })

    const capturePending = remoteCompaction.capturePending
    const releasePending = Effect.fn("SessionCompaction.releasePending")(function* (input: { sessionID: SessionID }) {
      yield* remoteCompaction.releasePending({ ...input, replayUser })
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: ModelRef
      auto: boolean
      phase?: Phase
      turnID?: MessageID
      overflow?: boolean
      transition?: CodexResponsesSessionCompaction.RemoteTransition
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
        model: input.transition?.sourceModel ?? (input.auto && turn ? turn.model : input.model),
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
        ...(input.transition
          ? {
              transition: {
                model: input.model,
                ...(input.transition.targetCompHash ? { comp_hash: input.transition.targetCompHash } : {}),
                reason: input.transition.reason,
              },
            }
          : {}),
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
      remoteTransition,
      recordRemoteTurn,
      saveRemoteTurn,
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
