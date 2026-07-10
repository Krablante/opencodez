import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError } from "../errors"
import { described } from "./metadata"

const root = "/opencodez/prompts"

export const OpenCodezPromptKind = Schema.Literals(["system", "tone", "template"]).annotate({
  identifier: "OpenCodezPromptKind",
})
export const OpenCodezPromptEntry = Schema.Struct({
  name: Schema.String,
  kind: OpenCodezPromptKind,
  source: Schema.Literals(["builtin", "library"]),
}).annotate({ identifier: "OpenCodezPromptEntry" })
export const OpenCodezPromptModel = Schema.Struct({
  id: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  api: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      npm: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "OpenCodezPromptModel" })
export const OpenCodezPromptStatePayload = Schema.Struct({
  sessionID: Schema.optional(SessionID),
  metadata: Schema.optional(Session.Metadata),
  model: Schema.optional(OpenCodezPromptModel),
})
export const OpenCodezPromptSelectPayload = Schema.Struct({
  ...OpenCodezPromptStatePayload.fields,
  kind: OpenCodezPromptKind,
  name: Schema.String,
})
export const OpenCodezPromptListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  kind: OpenCodezPromptKind,
})
export const OpenCodezPromptState = Schema.Struct({
  system: Schema.String,
  tone: Schema.String,
}).annotate({ identifier: "OpenCodezPromptState" })
export const OpenCodezPromptStateResult = Schema.Struct({
  state: OpenCodezPromptState,
  metadata: Session.Metadata,
}).annotate({ identifier: "OpenCodezPromptStateResult" })

export const OpenCodezPromptPaths = {
  list: root,
  state: `${root}/state`,
  select: `${root}/select`,
} as const

export const OpenCodezApi = HttpApi.make("opencodez").add(
  HttpApiGroup.make("opencodez")
    .add(
      HttpApiEndpoint.get("promptList", OpenCodezPromptPaths.list, {
        query: OpenCodezPromptListQuery,
        success: described(Schema.Array(OpenCodezPromptEntry), "List OpenCodez prompts"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "opencodez.prompt.list",
          summary: "List OpenCodez prompts",
          description: "List OpenCodez System, Tone, or Template prompt entries for the web composer.",
        }),
      ),
      HttpApiEndpoint.post("promptState", OpenCodezPromptPaths.state, {
        query: WorkspaceRoutingQuery,
        payload: OpenCodezPromptStatePayload,
        success: described(OpenCodezPromptStateResult, "OpenCodez prompt state"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "opencodez.prompt.state",
          summary: "Get OpenCodez prompt state",
          description: "Return the effective OpenCodez System and Tone for a session or draft metadata.",
        }),
      ),
      HttpApiEndpoint.post("promptSelect", OpenCodezPromptPaths.select, {
        query: WorkspaceRoutingQuery,
        payload: OpenCodezPromptSelectPayload,
        success: described(OpenCodezPromptStateResult, "Updated OpenCodez prompt state"),
        error: [HttpApiError.BadRequest, ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "opencodez.prompt.select",
          summary: "Select OpenCodez prompt",
          description: "Select a System or Tone prompt, or apply a Template as a System and Tone pair.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "opencodez", description: "OpenCodez-specific prompt controls." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
