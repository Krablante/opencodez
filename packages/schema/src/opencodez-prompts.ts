export * as OpenCodezPrompts from "./opencodez-prompts"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

export const Rule = Schema.Struct({
  scope: Schema.Literals(["model", "family", "all", "fallback"]),
  providerID: Schema.String,
  target: Schema.String,
  prompt: Schema.String,
  source: optional(Schema.Literals(["user", "builtin", "legacy"])),
}).annotate({ identifier: "OpenCodezPrompts.Rule" })
export interface Rule extends Schema.Schema.Type<typeof Rule> {}

export const Variant = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.String,
}).annotate({ identifier: "OpenCodezPrompts.Variant" })
export interface Variant extends Schema.Schema.Type<typeof Variant> {}

export const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  source: Schema.Literals(["builtin", "library"]),
  deleted: Schema.Boolean,
  version: Schema.String,
  origin: optional(Schema.Struct({ id: Schema.String, version: Schema.String })),
  sourceUpdated: Schema.Boolean,
}).annotate({ identifier: "OpenCodezPrompts.Entry" })
export interface Entry extends Schema.Schema.Type<typeof Entry> {}

export const Item = Schema.Struct({ ...Entry.fields, text: Schema.String }).annotate({
  identifier: "OpenCodezPrompts.Item",
})
export interface Item extends Schema.Schema.Type<typeof Item> {}

export const Model = Schema.Struct({
  id: Schema.String,
  apiID: Schema.String,
  name: Schema.String,
  providerID: Schema.String,
  providerName: Schema.String,
  family: Schema.String,
  variants: Schema.Array(Schema.String),
  effectivePrompt: optional(Schema.String),
}).annotate({ identifier: "OpenCodezPrompts.Model" })
export interface Model extends Schema.Schema.Type<typeof Model> {}

export const Catalog = Schema.Struct({
  revision: Schema.String,
  entries: Schema.Array(Entry),
  rules: Schema.Array(Rule),
  variants: Schema.Array(Variant),
  models: Schema.Array(Model),
}).annotate({ identifier: "OpenCodezPrompts.Catalog" })
export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}

export const Command = Schema.Struct({
  action: Schema.Literals(["save", "delete", "restore", "rules", "import", "variants"]),
  revision: Schema.String,
  id: optional(Schema.String),
  name: optional(Schema.String),
  description: optional(Schema.String),
  text: optional(Schema.String),
  version: optional(Schema.String),
  origin: optional(Schema.Struct({ id: Schema.String, version: Schema.String })),
  rules: optional(Schema.Array(Rule)),
  variants: optional(Schema.Array(Variant)),
  items: optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        description: Schema.String,
        text: Schema.String,
        mode: Schema.Literals(["keep", "replace", "copy"]),
        origin: optional(Schema.Struct({ id: Schema.String, version: Schema.String })),
      }),
    ),
  ),
}).annotate({ identifier: "OpenCodezPrompts.Command" })
export interface Command extends Schema.Schema.Type<typeof Command> {}

export class Error extends Schema.TaggedErrorClass<Error>()(
  "OpenCodezPrompts.Error",
  {
    message: Schema.String,
    code: Schema.Literals(["invalid", "conflict", "missing", "readonly", "io"]),
  },
  { httpApiStatus: 400 },
) {}

export const BundleEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  text: Schema.String,
  origin: optional(Schema.Struct({ id: Schema.String, version: Schema.String })),
})
export const Bundle = Schema.Struct({
  format: Schema.Literal("opencodez-prompts"),
  version: Schema.Literal(1),
  items: Schema.Array(BundleEntry),
  rules: Schema.Array(Rule),
}).annotate({ identifier: "OpenCodezPrompts.Bundle" })
export const Preview = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      ...BundleEntry.fields,
      status: Schema.Literals(["new", "same", "changed"]),
      builtin: optional(Schema.Boolean),
      replaceable: Schema.Boolean,
      mode: Schema.Literals(["keep", "replace", "copy"]),
    }),
  ),
  rules: Schema.Array(Rule),
}).annotate({ identifier: "OpenCodezPrompts.Preview" })
export interface Preview extends Schema.Schema.Type<typeof Preview> {}

export const Changed = Event.define({ type: "opencodez.prompts.changed", schema: { revision: Schema.String } })
