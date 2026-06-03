export * as ConfigOpencodez from "./opencodez"

import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"

export const Responses = Schema.Struct({
  system: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  tone: Schema.optional(Schema.String),
})

export const Pruning = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  pruning_size: Schema.optional(NonNegativeInt),
  preserve_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  prune: Schema.optional(
    Schema.Struct({
      reasoning: Schema.optional(Schema.Boolean),
      tool: Schema.optional(Schema.Boolean),
    }),
  ),
})

export const Info = Schema.Struct({
  responses: Schema.optional(Responses),
  pruning: Schema.optional(Pruning),
})

export type Info = Schema.Schema.Type<typeof Info>
