export * as ConfigOpencodez from "./opencodez"

import { Schema } from "effect"

export const Compaction = Schema.Struct({
  threshold: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0.9)),
  ).annotate({
    description:
      "ChatGPT OAuth remote compaction threshold as a fraction of the model input window (default: 0.9, maximum: 0.9)",
  }),
  token_limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
    description: "Optional lower absolute token cap for ChatGPT OAuth remote compaction",
  }),
})

export const Responses = Schema.Struct({
  system: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
  wire: Schema.optional(Schema.Literals(["legacy", "codex"])).annotate({
    description: "ChatGPT OAuth Responses wire mode (default: codex)",
  }),
  compaction: Schema.optional(Compaction).annotate({
    description: "ChatGPT OAuth server-side Responses compaction policy",
  }),
})

export const Info = Schema.Struct({
  responses: Schema.optional(Responses),
})

export type Info = Schema.Schema.Type<typeof Info>
