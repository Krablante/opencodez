export * as OpenCodezContext from "./opencodez-context"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

const Tokens = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Values = Schema.Struct({
  contextWindow: optional(Tokens),
  tokenLimit: optional(Tokens),
  auto: optional(Schema.Boolean),
}).annotate({ identifier: "OpenCodezContext.Values" })
export interface Values extends Schema.Schema.Type<typeof Values> {}

export const Target = Schema.Struct({
  scope: Schema.Literals(["model", "family"]),
  providerID: Schema.String,
  target: Schema.String,
}).annotate({ identifier: "OpenCodezContext.Target" })
export interface Target extends Schema.Schema.Type<typeof Target> {}

export const Rule = Schema.Struct({ ...Target.fields, ...Values.fields }).annotate({
  identifier: "OpenCodezContext.Rule",
})
export interface Rule extends Schema.Schema.Type<typeof Rule> {}

export const Effective = Schema.Struct({
  contextWindow: Schema.Finite,
  tokenLimit: Schema.Finite,
  auto: Schema.Boolean,
  maxContextWindow: Schema.Finite,
  maxTokenLimit: Schema.Finite,
  remote: Schema.Boolean,
}).annotate({ identifier: "OpenCodezContext.Effective" })
export interface Effective extends Schema.Schema.Type<typeof Effective> {}

export const Model = Schema.Struct({
  id: Schema.String,
  apiID: Schema.String,
  name: Schema.String,
  providerID: Schema.String,
  providerName: Schema.String,
  family: Schema.String,
  inherited: Values,
  effective: Effective,
}).annotate({ identifier: "OpenCodezContext.Model" })
export interface Model extends Schema.Schema.Type<typeof Model> {}

export const Catalog = Schema.Struct({
  revision: Schema.String,
  rules: Schema.Array(Rule),
  models: Schema.Array(Model),
}).annotate({ identifier: "OpenCodezContext.Catalog" })
export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}

export const Bundle = Schema.Struct({
  format: Schema.Literal("opencodez-context"),
  version: Schema.Literal(1),
  rules: Schema.Array(Rule),
}).annotate({ identifier: "OpenCodezContext.Bundle" })
export interface Bundle extends Schema.Schema.Type<typeof Bundle> {}

export const Preview = Schema.Struct({
  revision: Schema.String,
  items: Schema.Array(
    Schema.Struct({
      rule: Rule,
      current: optional(Rule),
      status: Schema.Literals(["new", "same", "changed"]),
      active: Schema.Boolean,
      name: Schema.String,
    }),
  ),
}).annotate({ identifier: "OpenCodezContext.Preview" })
export interface Preview extends Schema.Schema.Type<typeof Preview> {}

export const Command = Schema.Struct({
  revision: Schema.String,
  rules: Schema.Array(Rule),
  remove: optional(Schema.Array(Target)),
}).annotate({ identifier: "OpenCodezContext.Command" })
export interface Command extends Schema.Schema.Type<typeof Command> {}

export class Error extends Schema.TaggedErrorClass<Error>()(
  "OpenCodezContext.Error",
  { message: Schema.String, code: Schema.Literals(["invalid", "conflict", "io"]) },
  { httpApiStatus: 400 },
) {}

export const Changed = Event.define({ type: "opencodez.context.changed", schema: { revision: Schema.String } })
