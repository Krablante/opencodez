import { Config } from "@/config/config"
import { OpenCodezPromptLibrary } from "@/opencodez/prompt-library"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { OpenCodezPromptSelectPayload, OpenCodezPromptStatePayload } from "../groups/opencodez"
import * as SessionError from "./session-errors"
import { Provider } from "@/provider/provider"
import { OpenCodezPrompts } from "@opencode-ai/schema/opencodez-prompts"
import { EventV2 } from "@opencode-ai/core/event"
import { GlobalBus } from "@/bus/global"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import { SystemPrompt } from "@/session/system"

export const opencodezHandlers = HttpApiBuilder.group(InstanceHttpApi, "opencodez", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2.Service

    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          error instanceof OpenCodezPrompts.Error
            ? error
            : new OpenCodezPrompts.Error({ code: "io", message: "Unable to read or update the prompt library" }),
      })
    const library = Effect.fn("OpenCodezHttpApi.library")(function* () {
      const providers = yield* provider.list()
      const models = Object.values(providers).flatMap((item) =>
        Object.values(item.models).map((model) => ({
          id: model.id,
          apiID: model.api.id,
          name: model.name,
          providerID: item.id,
          providerName: item.name,
          family: model.family ?? "",
          variants: Object.keys(model.variants ?? {}),
        })),
      )
      const settings = yield* config.get()
      yield* attempt(() => OpenCodezPromptLibrary.ensureDefaults())
      const defaults = new Map(
        Object.values(providers).flatMap((item) =>
          Object.values(item.models).map(
            (model) =>
              [
                `${item.id}/${model.id}`,
                OpenCodezSettings.defaultSystem(settings, model) ?? `builtin:${SystemPrompt.providerName(model)}`,
              ] as const,
          ),
        ),
      )
      return yield* attempt(() => OpenCodezPromptLibrary.catalog(models, settings, defaults))
    })
    const libraryUpdate = Effect.fn("OpenCodezHttpApi.libraryUpdate")(function* (ctx: {
      payload: OpenCodezPrompts.Command
    }) {
      const catalog = yield* library()
      if (ctx.payload.variants) {
        const current = yield* library()
        for (const entry of ctx.payload.variants) {
          const model = current.models.find(
            (model) => model.providerID === entry.providerID && model.id === entry.modelID,
          )
          if (!model?.variants.includes(entry.variant))
            return yield* new OpenCodezPrompts.Error({
              code: "invalid",
              message: "This reasoning variant is not supported by the model",
            })
        }
      }
      const revision = yield* attempt(() => OpenCodezPromptLibrary.mutate(ctx.payload, catalog.rules))
      yield* events.publish(OpenCodezPrompts.Changed, { revision })
      GlobalBus.emit("event", { payload: { type: OpenCodezPrompts.Changed.type, properties: { revision } } })
      return yield* library()
    })

    const respond = Effect.fn("OpenCodezHttpApi.respond")(function* (input: {
      metadata: Record<string, unknown>
      model?: typeof OpenCodezPromptStatePayload.Type.model
    }) {
      const result = OpenCodezSession.indicatorFromMetadata({
        config: yield* config.get(),
        model: input.model,
        metadata: input.metadata,
      })
      const entry =
        result.system === "none" ? undefined : yield* attempt(() => OpenCodezPromptLibrary.item(result.system))
      return {
        state: {
          system: result.system,
          id: entry?.id,
          title: entry?.name,
          manual: result.systemManual,
          deleted: entry?.deleted,
        },
        metadata: input.metadata,
      }
    })

    const metadataFor = Effect.fn("OpenCodezHttpApi.metadataFor")(function* (
      input: typeof OpenCodezPromptStatePayload.Type,
    ) {
      if (!input.sessionID) return input.metadata ?? {}
      const current = yield* SessionError.mapStorageNotFound(session.get(input.sessionID))
      OpenCodezSession.hydrate(input.sessionID, current.metadata)
      return OpenCodezSession.metadataWithSessionState(current.metadata, input.sessionID)
    })

    const list = Effect.fn("OpenCodezHttpApi.promptList")(function* () {
      const current = yield* attempt(() => OpenCodezPromptLibrary.catalog([]))
      return current.entries
        .filter((entry) => !entry.deleted)
        .map((entry) => ({ name: entry.id, source: entry.source, id: entry.id, title: entry.name }))
    })

    const state = Effect.fn("OpenCodezHttpApi.promptState")(function* (ctx: {
      payload: typeof OpenCodezPromptStatePayload.Type
    }) {
      yield* attempt(() => OpenCodezPromptLibrary.ensureDefaults())
      return yield* respond({
        metadata: yield* metadataFor(ctx.payload),
        model: ctx.payload.model,
      })
    })

    const select = Effect.fn("OpenCodezHttpApi.promptSelect")(function* (ctx: {
      payload: typeof OpenCodezPromptSelectPayload.Type
    }) {
      const selection = yield* selectionFor(ctx.payload)
      if (!ctx.payload.sessionID) {
        return yield* respond({
          metadata: OpenCodezSession.metadataWithSelection(ctx.payload.metadata, selection),
          model: ctx.payload.model,
        })
      }

      const current = yield* SessionError.mapStorageNotFound(session.get(ctx.payload.sessionID))
      OpenCodezSession.apply(ctx.payload.sessionID, selection, current.metadata)
      const metadata = OpenCodezSession.metadataWithSessionState(current.metadata, ctx.payload.sessionID)
      yield* session.setMetadata({ sessionID: ctx.payload.sessionID, metadata })
      return yield* respond({ metadata, model: ctx.payload.model })
    })

    return handlers
      .handle("promptList", list)
      .handle("promptState", state)
      .handle("promptSelect", select)
      .handle("library", library)
      .handle("libraryItem", (ctx) => attempt(() => OpenCodezPromptLibrary.item(ctx.query.id)))
      .handle("libraryUpdate", libraryUpdate)
      .handle("libraryPreview", (ctx) => attempt(() => OpenCodezPromptLibrary.preview(ctx.payload.bundle)))
      .handle("libraryExport", (ctx) =>
        Effect.gen(function* () {
          const current = yield* library()
          return yield* attempt(() =>
            OpenCodezPromptLibrary.bundle(ctx.payload.ids, ctx.payload.includeRules, current.rules, current.models),
          )
        }),
      )
  }),
)

function selectionFor(input: typeof OpenCodezPromptSelectPayload.Type) {
  return Effect.gen(function* () {
    if (OpenCodezSession.isNone(input.name)) return OpenCodezSession.disable()
    if (input.name === "auto") return { system: null, systemManual: false }
    const entry = yield* Effect.promise(() => OpenCodezPromptLibrary.get(input.name))
    if (!entry) return yield* new HttpApiError.BadRequest({})
    return { system: input.name, systemManual: true }
  })
}
