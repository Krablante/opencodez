import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionID, MessageID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Effect, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { EventV2 } from "@opencode-ai/core/event"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CodexResponsesCompact } from "./compact"
import { CodexResponsesCompaction } from "./compaction"
import { CodexResponsesCatalog } from "./catalog"
import { SystemPrompt } from "@/session/system"
import { Usage } from "@opencode-ai/llm"
import type { TaskPromptOps } from "@/tool/task"
import { SessionModelContext } from "@/session/model-context"
import { LLMRequestPrep } from "@/session/llm/request"
import { Instruction } from "@/session/instruction"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { errorMessage } from "@/util/error"
import { Auth } from "@/auth"
import { Session } from "@/session/session"
import { Config } from "@/config/config"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { CodexResponsesProtocol } from "./protocol"
import { isOverflow } from "@/session/overflow"
import { isRecord } from "@/util/record"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const timeout = 20 * 60_000
type Phase = NonNullable<SessionV1.CompactionPart["phase"]>
type Replay = { info: SessionV1.User; parts: SessionV1.Part[] }
type ModelRef = { providerID: ProviderV2.ID; modelID: ModelV2.ID }
export type RemoteTransition = {
  sourceModel: ModelRef
  targetCompHash?: string
  reason: "comp_hash_changed" | "model_downshift"
}
type Complete = (input: {
  sessionID: SessionID
  userMessage: SessionV1.User
  replay?: Replay
  result: "continue" | "stop"
  auto: boolean
  phase?: Phase
  direct?: boolean
  overflow?: boolean
  replaceReplayMedia?: boolean
  compactionPart?: SessionV1.CompactionPart
}) => Effect.Effect<"continue" | "stop">

type Dependencies = {
  session: Session.Interface
  agents: Agent.Interface
  plugin: Plugin.Interface
  provider: Provider.Interface
  events: EventV2.Interface
  flags: RuntimeFlags.Info
  instruction: Instruction.Interface
  system: SystemPrompt.Interface
  permission: Permission.Interface
  registry: ToolRegistry.Interface
  mcp: MCP.Interface
  truncate: Truncate.Interface
  config: Config.Interface
  auth: Auth.Interface
}

type ProcessInput = {
  remote: boolean
  sessionID: SessionID
  parentID: MessageID
  messages: SessionV1.WithParts[]
  history: SessionV1.WithParts[]
  userMessage: SessionV1.User
  compactionPart?: SessionV1.CompactionPart
  phase?: Phase
  replay?: Replay
  pending: SessionV1.WithParts[]
  auto: boolean
  overflow?: boolean
  abort?: AbortSignal
  prepared?: LLMRequestPrep.Prepared
  promptOps?: TaskPromptOps
  sourceModel: Provider.Model
  targetModel: Provider.Model
  authInfo?: Auth.Info
  accountKey?: string
  turnID?: MessageID
  targetProfile?: CodexResponsesCatalog.Profile
  previousCompaction?: ReturnType<typeof CodexResponsesCompaction.latest>
  transition?: NonNullable<SessionV1.CompactionPart["transition"]>
  cfg: ConfigV1.Info
  complete: Complete
}

export function make(deps: Dependencies) {
  const checkOverflow = Effect.fn("CodexResponsesSessionCompaction.isOverflow")(function* (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
    additionalTokens?: number
    turn?: CodexResponsesCompaction.TurnSettings
    profile?: CodexResponsesCatalog.Profile
    serverReasoningIncluded?: boolean
    messages?: SessionV1.WithParts[]
    turnID?: MessageID
  }) {
    const cfg = yield* deps.config.get()
    const authInfo = yield* deps.auth.get(input.model.providerID).pipe(Effect.orDie)
    const codexResponses = LLMRequestPrep.isCodexResponses({
      providerID: input.model.providerID,
      modelNpm: input.model.api.npm,
      authType: authInfo?.type,
      config: cfg,
    })
    const profile =
      codexResponses && authInfo?.type === "oauth"
        ? input.profile?.modelID === input.model.api.id
          ? input.profile
          : input.turn?.profile?.modelID === input.model.api.id
            ? input.turn.profile
            : CodexResponsesCatalog.resolve(
                input.model,
                CodexResponsesProtocol.accountKey(authInfo.accountId, authInfo.access),
                undefined,
                OpenCodezSettings.responsesContextWindow(cfg),
              )
        : undefined
    const limit =
      codexResponses && authInfo?.type === "oauth"
        ? OpenCodezSettings.responsesCompactionLimit(
            cfg,
            input.model.limit,
            profile?.autoCompactTokenLimit ?? profile?.contextWindow,
          )
        : undefined
    return isOverflow({
      cfg,
      tokens: input.tokens,
      model: input.model,
      outputTokenMax: deps.flags.outputTokenMax,
      limit,
      additionalTokens:
        (input.additionalTokens ?? 0) +
        (codexResponses && input.serverReasoningIncluded !== true && input.messages && input.turnID
          ? historicalReasoningTokens(input.messages, input.turnID)
          : 0),
    })
  })

  const saveTurnSettings = Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    turnID: MessageID
    model: ModelRef
    apiModelID?: string
    compHash?: string
    accountKey?: string
    profile?: CodexResponsesCatalog.Profile
    serverReasoningIncluded?: boolean
  }) {
    const info = yield* deps.session.get(input.sessionID).pipe(Effect.orDie)
    const metadata = CodexResponsesCompaction.withTurnSettings(info.metadata, {
      turnID: input.turnID,
      model: { ...input.model, apiModelID: input.apiModelID },
      compHash: input.compHash,
      accountKey: input.accountKey,
      profile: input.profile,
      serverReasoningIncluded: input.serverReasoningIncluded,
    })
    if (metadata === info.metadata) return
    yield* deps.session.setMetadata({ sessionID: input.sessionID, metadata })
  })

  const recordRemoteTurn = Effect.fn("CodexResponsesSessionCompaction.recordRemoteTurn")(function* (input: {
    sessionID: SessionID
    turnID: MessageID
    model: Provider.Model
  }) {
    if (input.model.providerID !== "openai") return undefined
    const [cfg, authInfo] = yield* Effect.all(
      [deps.config.get(), deps.auth.get(input.model.providerID).pipe(Effect.orDie)],
      { concurrency: "unbounded" },
    )
    if (authInfo?.type !== "oauth") return undefined
    if (
      !LLMRequestPrep.isCodexResponses({
        providerID: input.model.providerID,
        modelNpm: input.model.api.npm,
        authType: authInfo.type,
        config: cfg,
      })
    )
      return undefined
    const accountKey = CodexResponsesProtocol.accountKey(authInfo.accountId, authInfo.access)
    if (!accountKey) return undefined
    const info = yield* deps.session.get(input.sessionID).pipe(Effect.orDie)
    const journal = CodexResponsesCompaction.turnSettings(info.metadata)
    const existing = journal.find((item) => item.turnID === input.turnID)
    if (existing?.accountKey && existing.accountKey !== accountKey) {
      throw new Error("The ChatGPT login changed during the active turn. Retry with a new message to continue safely.")
    }
    if (existing?.profile) return existing
    yield* Effect.promise(() => CodexResponsesCatalog.settleRefresh(accountKey))
    const profile = CodexResponsesCatalog.resolve(
      input.model,
      accountKey,
      undefined,
      OpenCodezSettings.responsesContextWindow(cfg),
    )
    if (existing?.compHash && profile?.compHash && existing.compHash !== profile.compHash) {
      throw new Error(
        "The ChatGPT backend changed while resuming the active turn. Retry with a new message to continue safely.",
      )
    }
    const settings = {
      turnID: input.turnID,
      model: {
        providerID: input.model.providerID,
        modelID: input.model.id,
        apiModelID: input.model.api.id,
      },
      compHash: existing?.compHash ?? profile?.compHash,
      accountKey,
      profile,
      serverReasoningIncluded: existing?.serverReasoningIncluded,
    } satisfies CodexResponsesCompaction.TurnSettings
    yield* saveTurnSettings({
      sessionID: input.sessionID,
      turnID: input.turnID,
      model: { providerID: input.model.providerID, modelID: input.model.id },
      apiModelID: input.model.api.id,
      compHash: settings.compHash,
      accountKey,
      profile,
      serverReasoningIncluded: settings.serverReasoningIncluded,
    })
    return settings
  })

  const saveRemoteTurn = Effect.fn("CodexResponsesSessionCompaction.saveRemoteTurn")(function* (input: {
    sessionID: SessionID
    settings: CodexResponsesCompaction.TurnSettings
  }) {
    yield* saveTurnSettings({
      sessionID: input.sessionID,
      turnID: MessageID.make(input.settings.turnID),
      model: {
        providerID: ProviderV2.ID.make(input.settings.model.providerID),
        modelID: ModelV2.ID.make(input.settings.model.modelID),
      },
      apiModelID: input.settings.model.apiModelID,
      compHash: input.settings.compHash,
      accountKey: input.settings.accountKey,
      profile: input.settings.profile,
      serverReasoningIncluded: input.settings.serverReasoningIncluded,
    })
  })

  const remoteTransition = Effect.fn("CodexResponsesSessionCompaction.remoteTransition")(function* (input: {
    sessionID: SessionID
    turnID: MessageID
    messages: SessionV1.WithParts[]
    model: Provider.Model
    tokens?: SessionV1.Assistant["tokens"]
  }) {
    if (input.model.providerID !== "openai") return undefined
    const [cfg, authInfo] = yield* Effect.all(
      [deps.config.get(), deps.auth.get(input.model.providerID).pipe(Effect.orDie)],
      { concurrency: "unbounded" },
    )
    if (authInfo?.type !== "oauth") return undefined
    if (
      !LLMRequestPrep.isCodexResponses({
        providerID: input.model.providerID,
        modelNpm: input.model.api.npm,
        authType: authInfo.type,
        config: cfg,
      })
    )
      return undefined
    const accountKey = CodexResponsesProtocol.accountKey(authInfo.accountId, authInfo.access)
    if (!accountKey) return undefined
    yield* Effect.promise(() => CodexResponsesCatalog.settleRefresh(accountKey))
    const profile = CodexResponsesCatalog.resolve(
      input.model,
      accountKey,
      undefined,
      OpenCodezSettings.responsesContextWindow(cfg),
    )
    if (!profile) return undefined
    const info = yield* deps.session.get(input.sessionID).pipe(Effect.orDie)
    const settings = CodexResponsesCompaction.turnSettings(info.metadata)
    if (settings.some((item) => item.turnID === input.turnID)) return undefined

    const currentIndex = input.messages.findLastIndex((message) => message.info.id === input.turnID)
    if (currentIndex < 0) return undefined
    const previousUser = input.messages
      .slice(0, currentIndex)
      .findLast(
        (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
          message.info.role === "user" && !message.parts.some((part) => part.type === "compaction"),
      )
    const exact = previousUser ? settings.findLast((item) => item.turnID === previousUser.info.id) : undefined
    const knownTurnIDs = new Set<string>(input.messages.map((message) => message.info.id))
    const forked = settings.length > 0 && settings.every((item) => !knownTurnIDs.has(item.turnID))
    const previous =
      exact ??
      (forked && previousUser
        ? settings.findLast(
            (item) =>
              item.model.providerID === previousUser.info.model.providerID &&
              item.model.modelID === previousUser.info.model.modelID,
          )
        : undefined)
    const previousRef = previous
      ? {
          providerID: ProviderV2.ID.make(previous.model.providerID),
          modelID: ModelV2.ID.make(previous.model.modelID),
        }
      : previousUser?.info.model.providerID === "openai"
        ? {
            providerID: previousUser.info.model.providerID,
            modelID: previousUser.info.model.modelID,
          }
        : undefined
    const previousModel = previousRef
      ? yield* deps.provider.getModel(previousRef.providerID, previousRef.modelID).pipe(Effect.option)
      : Option.none<Provider.Model>()
    const previousCompHash =
      previous?.compHash ??
      (Option.isSome(previousModel)
        ? CodexResponsesCatalog.resolve(previousModel.value, accountKey)?.compHash
        : undefined)
    if (previousCompHash && profile.compHash && previousCompHash !== profile.compHash) {
      return {
        sourceModel: Option.isSome(previousModel)
          ? { providerID: previousModel.value.providerID, modelID: previousModel.value.id }
          : { providerID: input.model.providerID, modelID: input.model.id },
        targetCompHash: profile.compHash,
        reason: "comp_hash_changed",
      } satisfies RemoteTransition
    }

    if (Option.isSome(previousModel) && input.tokens && previousModel.value.api.id !== input.model.api.id) {
      const previousProfile =
        previous?.profile?.modelID === previousModel.value.api.id
          ? previous.profile
          : CodexResponsesCatalog.resolve(
              previousModel.value,
              accountKey,
              undefined,
              OpenCodezSettings.responsesContextWindow(cfg),
            )
      const previousWindow = modelContextWindow(previousModel.value, previousProfile)
      const currentWindow = modelContextWindow(input.model, profile)
      if (
        previousWindow !== undefined &&
        currentWindow !== undefined &&
        previousWindow > currentWindow &&
        (yield* checkOverflow({
          tokens: input.tokens,
          model: input.model,
          profile,
          serverReasoningIncluded: previous?.serverReasoningIncluded,
          messages: input.messages,
          turnID: input.turnID,
        }))
      ) {
        return {
          sourceModel: { providerID: previousModel.value.providerID, modelID: previousModel.value.id },
          targetCompHash: profile.compHash,
          reason: "model_downshift",
        } satisfies RemoteTransition
      }
    }

    const context = CodexResponsesCompaction.latest(input.messages)
    if (!context || !profile.compHash || context.compHash === profile.compHash) return undefined
    const sourceModel =
      Option.isSome(previousModel) && context.modelID === previousModel.value.api.id
        ? { providerID: previousModel.value.providerID, modelID: previousModel.value.id }
        : { providerID: input.model.providerID, modelID: input.model.id }
    return { sourceModel, targetCompHash: profile.compHash, reason: "comp_hash_changed" } satisfies RemoteTransition
  })

  const pendingUsers = Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    turnID: MessageID
    markerID: MessageID
  }) {
    const messages = yield* deps.session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
    const turnIndex = messages.findIndex((message) => message.info.id === input.turnID)
    if (turnIndex < 0) return []
    return messages
      .slice(turnIndex + 1)
      .filter(
        (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
          message.info.role === "user" &&
          message.info.id !== input.markerID &&
          !message.parts.some((part) => part.type === "compaction"),
      )
  })

  const process = Effect.fn("CodexResponsesSessionCompaction.process")(function* (input: ProcessInput) {
    if (!input.remote) return undefined
    if (!input.accountKey) throw new Error("OpenAI remote compaction requires a verified ChatGPT account identity")
    const accountKey = input.accountKey
    if (!input.compactionPart) throw new Error(`Missing compaction part for ${input.parentID}`)
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
      variant: input.userMessage.model.variant,
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
      modelID: input.sourceModel.id,
      providerID: input.sourceModel.providerID,
      time: { created: Date.now() },
    }
    yield* deps.session.updateMessage(msg)
    yield* deps.events.publish(MessageV2.Event.Updated, { sessionID: input.sessionID, info: msg })

    yield* Effect.logInfo("remote compaction", {
      "session.id": input.sessionID,
      phase: input.phase ?? "manual",
      messages: input.history.length,
    })
    const compacted = yield* Effect.gen(function* () {
      const requestUser =
        input.messages.find(
          (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
            message.info.role === "user" && message.info.id === input.turnID,
        )?.info ??
        input.replay?.info ??
        input.messages.findLast(
          (message): message is SessionV1.WithParts & { info: SessionV1.User } =>
            message.info.role === "user" && !message.parts.some((part) => part.type === "compaction"),
        )?.info
      if (!requestUser) throw new Error(`Missing request user for compaction ${input.parentID}`)
      const requestAgent = yield* deps.agents.get(requestUser.agent)
      if (!requestAgent) throw new Error(`Agent not found for compaction: ${requestUser.agent}`)
      const sessionInfo = yield* deps.session.get(input.sessionID).pipe(Effect.orDie)
      const active = CodexResponsesCompaction.tail(input.history)
      const abort = input.abort ?? AbortSignal.timeout(timeout)
      const run = (attemptModel: Provider.Model, snapshot?: LLMRequestPrep.Prepared) =>
        Effect.gen(function* () {
          const providerInfo = yield* deps.provider.getProvider(attemptModel.providerID)
          const prepared = snapshot
            ? yield* Effect.gen(function* () {
                if (input.phase === "mid-turn" && input.overflow && input.pending.length === 0) return snapshot
                const messages = structuredClone(active.messages)
                yield* deps.plugin.trigger("experimental.chat.messages.transform", {}, { messages })
                return {
                  ...snapshot,
                  messages: yield* MessageV2.toModelMessagesEffect(messages, attemptModel),
                }
              })
            : yield* Effect.gen(function* () {
                const context = yield* SessionModelContext.resolve({
                  agent: requestAgent,
                  model: attemptModel,
                  session: sessionInfo,
                  messages: structuredClone(active.messages),
                  promptOps,
                }).pipe(
                  Effect.provideService(Plugin.Service, deps.plugin),
                  Effect.provideService(Permission.Service, deps.permission),
                  Effect.provideService(ToolRegistry.Service, deps.registry),
                  Effect.provideService(MCP.Service, deps.mcp),
                  Effect.provideService(Truncate.Service, deps.truncate),
                  Effect.provideService(RuntimeFlags.Service, deps.flags),
                  Effect.provideService(Instruction.Service, deps.instruction),
                  Effect.provideService(SystemPrompt.Service, deps.system),
                )
                return yield* LLMRequestPrep.prepare({
                  user: requestUser,
                  turnID: input.phase === "mid-turn" ? input.turnID : undefined,
                  sessionID: input.sessionID,
                  parentSessionID: sessionInfo.parentID,
                  sessionMetadata: CodexResponsesCompaction.withMetadata(sessionInfo.metadata, input.history),
                  model: attemptModel,
                  agent: requestAgent,
                  permission: sessionInfo.permission,
                  system: context.system,
                  messages: context.messages,
                  tools: context.tools,
                  provider: providerInfo,
                  auth: input.authInfo,
                  plugin: deps.plugin,
                  flags: deps.flags,
                  isWorkflow: false,
                  config: input.cfg,
                  allowCompHashMismatch: true,
                })
              })
          return yield* CodexResponsesCompact.compact({
            model: attemptModel,
            provider: providerInfo,
            system: prepared.system,
            messages: prepared.messages,
            tools: prepared.tools,
            options: prepared.params.options,
            items: active.items,
            sessionID: input.sessionID,
            accountKey,
            turnProfile:
              prepared.codexResponsesTurn?.settings.profile?.modelID === attemptModel.api.id
                ? prepared.codexResponsesTurn.settings.profile
                : undefined,
            windowID: input.previousCompaction?.messageID ?? input.sessionID,
            turnID: input.phase === "mid-turn" ? input.turnID : undefined,
            compaction: {
              trigger: input.auto ? "auto" : "manual",
              reason:
                input.transition?.reason ??
                (input.auto &&
                input.previousCompaction?.compHash &&
                input.targetProfile?.compHash &&
                input.targetProfile.compHash !== input.previousCompaction.compHash
                  ? "comp_hash_changed"
                  : input.auto
                    ? "context_limit"
                    : "user_requested"),
              phase:
                input.phase === "pre-turn" ? "pre_turn" : input.phase === "mid-turn" ? "mid_turn" : "standalone_turn",
            },
            preserveActiveToolMedia: input.phase === "mid-turn",
            abort,
          }).pipe(Effect.timeout(timeout))
        })
      const attempt = (attemptModel: Provider.Model, snapshot?: LLMRequestPrep.Prepared) =>
        run(attemptModel, snapshot).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value, model: attemptModel }),
          }),
        )
      const primary = yield* attempt(input.sourceModel, input.transition ? undefined : input.prepared)
      if (primary.ok) return primary
      if (
        !input.transition ||
        input.sourceModel.id === input.targetModel.id ||
        !CodexResponsesCompact.canRetryWithCurrentModel(primary.error)
      )
        return primary
      yield* Effect.logWarning("previous-model remote compaction failed; retrying current model", {
        "session.id": input.sessionID,
        previousModel: input.sourceModel.api.id,
        currentModel: input.targetModel.api.id,
        error: errorMessage(primary.error),
      })
      const fallback = yield* attempt(input.targetModel)
      if (fallback.ok) return fallback
      yield* Effect.logError("current-model remote compaction fallback failed", {
        "session.id": input.sessionID,
        previousModel: input.sourceModel.api.id,
        currentModel: input.targetModel.api.id,
        error: errorMessage(fallback.error),
      })
      return primary
    })

    if (!compacted.ok) {
      yield* Effect.logError("remote compaction failed", {
        "session.id": input.sessionID,
        phase: input.phase ?? "manual",
        error: errorMessage(compacted.error),
      })
      msg.error = MessageV2.fromError(compacted.error, { providerID: input.sourceModel.providerID })
      msg.finish = "error"
      msg.time.completed = Date.now()
      yield* deps.session.updateMessage(msg)
      return "stop" as const
    }
    if (compacted.value.trimmedOutputs > 0) {
      yield* Effect.logInfo("trimmed remote compaction tool outputs", {
        "session.id": input.sessionID,
        count: compacted.value.trimmedOutputs,
      })
    }

    const currentPart = yield* deps.session.getPart({
      sessionID: input.sessionID,
      messageID: input.compactionPart.messageID,
      partID: input.compactionPart.id,
    })
    const discoveredPending = input.turnID
      ? yield* pendingUsers({ sessionID: input.sessionID, turnID: input.turnID, markerID: input.parentID })
      : []
    yield* deps.session.updatePart({
      ...input.compactionPart,
      ...(currentPart?.type === "compaction" && currentPart.tail_start_id
        ? { tail_start_id: currentPart.tail_start_id }
        : discoveredPending[0]
          ? { tail_start_id: discoveredPending[0].info.id }
          : {}),
      remote: {
        providerID: "openai",
        items: compacted.value.items,
        model_id: input.targetModel.api.id,
        comp_hash: input.transition?.comp_hash ?? input.targetProfile?.compHash,
      },
    })
    const usage = Session.getUsage({
      model: compacted.model,
      usage: new Usage({
        totalTokens: compacted.value.usage.total,
        inputTokens: compacted.value.usage.input,
        outputTokens: compacted.value.usage.output,
        reasoningTokens: compacted.value.usage.reasoning,
      }),
    })
    msg.cost = usage.cost
    msg.tokens = usage.tokens
    msg.modelID = compacted.model.id
    msg.providerID = compacted.model.providerID
    msg.finish = "stop"
    msg.time.completed = Date.now()
    yield* deps.session.updateMessage(msg)
    return yield* input.complete({
      sessionID: input.sessionID,
      userMessage: input.userMessage,
      replay: input.replay,
      result: "continue",
      auto: input.auto,
      phase: input.phase,
      direct: input.phase === "mid-turn",
      overflow: input.overflow,
      replaceReplayMedia: false,
      compactionPart: input.compactionPart,
    })
  })

  const capturePending = Effect.fn("CodexResponsesSessionCompaction.capturePending")(function* (input: {
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
    const summaryIndex = summary ? input.messages.findIndex((message) => message.info.id === summary.info.id) : -1
    const continuation = summary
      ? input.messages
          .slice(summaryIndex + 1)
          .find(
            (message) =>
              message.info.role === "assistant" &&
              message.info.summary !== true &&
              message.info.parentID === marker.info.id,
          )
      : undefined
    if (!summary || continuation) return false
    const pending = yield* pendingUsers({
      sessionID: input.sessionID,
      turnID: part.turn_id,
      markerID: marker.info.id,
    })
    if (!pending[0]) return false
    yield* deps.session.updatePart({ ...part, tail_start_id: pending[0].info.id })
    return true
  })

  const releasePending = Effect.fn("CodexResponsesSessionCompaction.releasePending")(function* (input: {
    sessionID: SessionID
    replayUser: (input: { sessionID: SessionID; message: Replay; replaceMedia: boolean }) => Effect.Effect<unknown>
  }) {
    const messages = yield* deps.session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
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
    const summaryIndex = messages.findIndex((message) => message.info.id === summary.info.id)
    const continuation = messages
      .slice(summaryIndex + 1)
      .find(
        (message) =>
          message.info.role === "assistant" &&
          message.info.summary !== true &&
          message.info.parentID === marker.info.id &&
          message.info.time.completed !== undefined,
      )
    if (!continuation) return

    const pending = yield* pendingUsers({
      sessionID: input.sessionID,
      turnID: part.turn_id,
      markerID: marker.info.id,
    })
    for (const message of pending) {
      yield* input.replayUser({ sessionID: input.sessionID, message, replaceMedia: false })
    }
    const markerIndex = messages.findIndex((message) => message.info.id === marker.info.id)
    const afterMarker = new Set(messages.slice(markerIndex + 1).map((message) => message.info.id))
    for (const message of pending) {
      if (afterMarker.has(message.info.id)) {
        yield* deps.session.removeMessage({ sessionID: input.sessionID, messageID: message.info.id })
      }
    }
    yield* deps.session.updatePart({ ...part, tail_start_id: undefined })
    yield* Effect.logInfo("released pending input after remote compaction", {
      "session.id": input.sessionID,
      count: pending.length,
    })
  })

  return {
    isOverflow: checkOverflow,
    saveTurnSettings,
    recordRemoteTurn,
    saveRemoteTurn,
    remoteTransition,
    process,
    capturePending,
    releasePending,
  }
}

function modelContextWindow(model: Provider.Model, profile: CodexResponsesCatalog.Profile | undefined) {
  const limits = [model.limit.input, model.limit.context, profile?.contextWindow].filter(
    (value): value is number => typeof value === "number" && value > 0,
  )
  return limits.length > 0 ? Math.min(...limits) : undefined
}

function historicalReasoningTokens(messages: SessionV1.WithParts[], turnID: MessageID) {
  const boundary = messages.findIndex((message) => message.info.role === "user" && message.info.id === turnID)
  if (boundary < 0) return 0
  return messages.slice(0, boundary).reduce((total, message) => {
    return (
      total +
      message.parts.reduce((subtotal, part) => {
        if (part.type !== "reasoning" || !isRecord(part.metadata) || !isRecord(part.metadata.openai)) return subtotal
        const encrypted = part.metadata.openai.reasoningEncryptedContent
        if (typeof encrypted !== "string") return subtotal
        const bytes = Math.max(0, Math.floor((encrypted.length * 3) / 4) - 650)
        return subtotal + Math.ceil(bytes / 4)
      }, 0)
    )
  }, 0)
}

export * as CodexResponsesSessionCompaction from "./session-compaction"
