import { Config } from "@/config/config"
import { OpenCodezPromptLibrary } from "@/opencodez/prompt-library"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  OpenCodezPromptListQuery,
  OpenCodezPromptSelectPayload,
  OpenCodezPromptStatePayload,
} from "../groups/opencodez"
import * as SessionError from "./session-errors"

export const opencodezHandlers = HttpApiBuilder.group(InstanceHttpApi, "opencodez", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service

    const respond = Effect.fn("OpenCodezHttpApi.respond")(function* (input: {
      metadata: Record<string, unknown>
      model?: typeof OpenCodezPromptStatePayload.Type.model
    }) {
      const result = OpenCodezSession.indicatorFromMetadata({
        config: yield* config.get(),
        model: input.model,
        metadata: input.metadata,
      })
      return {
        state: {
          system: result.system,
          tone: result.tone ?? "none",
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

    const list = Effect.fn("OpenCodezHttpApi.promptList")(function* (ctx: {
      query: typeof OpenCodezPromptListQuery.Type
    }) {
      const kind = ctx.query.kind === "system" ? "core" : ctx.query.kind === "tone" ? "tone" : "templates"
      return yield* Effect.promise(() => OpenCodezPromptLibrary.list(kind)).pipe(
        Effect.map((entries) =>
          entries.map((entry) => ({
            name: entry.name,
            kind: ctx.query.kind,
            source: entry.source,
          })),
        ),
      )
    })

    const state = Effect.fn("OpenCodezHttpApi.promptState")(function* (ctx: {
      payload: typeof OpenCodezPromptStatePayload.Type
    }) {
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

    return handlers.handle("promptList", list).handle("promptState", state).handle("promptSelect", select)
  }),
)

function selectionFor(input: typeof OpenCodezPromptSelectPayload.Type) {
  return Effect.gen(function* () {
    if (input.kind === "system") {
      if (OpenCodezSession.isNone(input.name)) return OpenCodezSession.disable("system")
      const entry = yield* Effect.promise(() => OpenCodezPromptLibrary.get("core", input.name))
      if (!entry) return yield* new HttpApiError.BadRequest({})
      return { system: input.name, systemManual: true }
    }

    if (input.kind === "tone") {
      if (OpenCodezSession.isNone(input.name)) return OpenCodezSession.disable("tone")
      const entry = yield* Effect.promise(() => OpenCodezPromptLibrary.get("tone", input.name))
      if (!entry) return yield* new HttpApiError.BadRequest({})
      return { tone: input.name, toneManual: true }
    }

    const template = yield* Effect.promise(() => OpenCodezPromptLibrary.readTemplate(input.name))
    if (!template) return yield* new HttpApiError.BadRequest({})
    return {
      system: template.system,
      tone: template.tone,
      systemManual: true,
      toneManual: true,
    }
  })
}
