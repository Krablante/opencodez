import { Global } from "@opencode-ai/core/global"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import type { Config, OpenCodezPromptEntry } from "@opencode-ai/sdk/v2"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export function OpenCodezPromptSelector(props: {
  kind: "system" | "tone" | "template"
  entries: OpenCodezPromptEntry[]
  sessionID?: string
  metadata?: Record<string, unknown>
  config?: Config
  model?: OpenCodezSettings.ModelLike
}) {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  const current = createMemo(() => {
    const indicator = OpenCodezSession.indicator({
      config: props.config,
      model: props.model,
      sessionID: props.sessionID,
      metadata: props.metadata,
    })
    if (props.kind === "system") return indicator.system
    if (props.kind === "tone") return indicator.tone ?? OpenCodezSession.noneID
    return undefined
  })
  const options = createMemo(() => {
    const prompts = props.entries.map((item) => ({
      title: item.name,
      value: item.name,
      description: item.source,
    }))
    if (props.kind === "template") return prompts
    return [
      {
        title: "None",
        value: OpenCodezSession.noneID,
        description: `Disable ${props.kind === "system" ? "System" : "Tone"} prompt for this session`,
      },
      ...prompts,
    ]
  })

  return (
    <DialogSelect
      title={props.kind === "system" ? "Select System" : props.kind === "tone" ? "Select Tone" : "Select Template"}
      placeholder="Type to filter"
      current={current()}
      flat
      options={options()}
      onSelect={(option) => {
        void applySelection(sdk.client, props.kind, option.value, props.sessionID, props.metadata, props.model)
          .then((label) => {
            toast.show({ message: label, variant: "info", duration: 2500 })
            dialog.clear()
          })
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : String(error),
              variant: "error",
              duration: 3500,
            })
          })
      }}
    />
  )
}

export function OpenCodezPromptsHelpDialog() {
  const root = `${Global.Path.config}/prompts`
  return (
    <DialogAlert
      title="Prompt library"
      message={[
        "Core prompts:",
        `  ${root}/core/`,
        "",
        "Tone presets:",
        `  ${root}/tone/`,
        "",
        "Templates:",
        `  ${root}/templates/`,
        "",
        "Model defaults:",
        `  ${Global.Path.config}/opencode.jsonc`,
      ].join("\n")}
    />
  )
}

export function OpenCodezPruningStatusDialog(props: {
  sessionID?: string
  metadata?: Record<string, unknown>
  config?: Config
}) {
  const settings = OpenCodezSession.effectivePruning({
    config: props.config,
    sessionID: props.sessionID,
    metadata: props.metadata,
  })
  const message = [
    `enabled: ${settings.enabled}`,
    `pruning_size: ${settings.pruning_size}`,
    `reasoning: ${settings.prune.reasoning}`,
    `tool: ${settings.prune.tool}`,
    `preserve_tools: ${settings.preserve_tools.length ? settings.preserve_tools.join(", ") : "[]"}`,
  ].join("\n")
  return <DialogAlert title="Pruning" message={message} />
}

async function applySelection(
  client: ReturnType<typeof useSDK>["client"],
  kind: "system" | "tone" | "template",
  name: string,
  sessionID: string | undefined,
  metadata: Record<string, unknown> | undefined,
  model: OpenCodezSettings.ModelLike | undefined,
) {
  const result = await client.opencodez.prompt.select({
    sessionID,
    metadata: sessionID ? undefined : metadata,
    model: kind === "template" ? undefined : modelPayload(model),
    kind,
    name,
  })
  if (result.error || !result.data) throw new Error(`Nothing found for "${name}". Try another name.`)
  if (sessionID) OpenCodezSession.hydrate(sessionID, result.data.metadata)
  else {
    const state = OpenCodezSession.fromMetadata(result.data.metadata)
    OpenCodezSession.resetPending(state.selection ?? {}, state.pruning ?? {})
  }

  if (kind === "system") return `System set to ${OpenCodezSession.isNone(name) ? "None" : name}`
  if (kind === "tone") return `Tone set to ${OpenCodezSession.isNone(name) ? "None" : name}`
  return `Template set to ${name}`
}

function modelPayload(model: OpenCodezSettings.ModelLike | undefined) {
  if (typeof model === "string") return { id: model }
  return model
}
