import type { Config } from "@opencode-ai/sdk/v2"
import { createMemo } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogAlert } from "../ui/dialog-alert"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { OpenCodezPromptLibrary } from "@/opencodez/prompt-library"
import { OpenCodezSession } from "@/opencodez/session"
import { OpenCodezSettings } from "@/opencodez/settings"

export function OpenCodezPromptSelector(props: {
  kind: "system" | "tone" | "template"
  entries: OpenCodezPromptLibrary.Entry[]
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
    if (props.kind === "tone") return indicator.tone
    return undefined
  })

  return (
    <DialogSelect
      title={props.kind === "system" ? "Select System" : props.kind === "tone" ? "Select Tone" : "Select Template"}
      placeholder="Type to filter"
      current={current()}
      flat
      options={props.entries.map((item) => ({
        title: item.name,
        value: item.name,
        description: item.path,
      }))}
      onSelect={(option) => {
        void applySelection(props.kind, option.value, props.sessionID, props.metadata)
          .then(async (label) => {
            await persistSelection(sdk.client, props.sessionID, props.metadata)
            return label
          })
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
  return <DialogAlert title="Prompt library" message={OpenCodezPromptLibrary.helpText()} />
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
  kind: "system" | "tone" | "template",
  name: string,
  sessionID: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  if (kind === "system") {
    OpenCodezSession.apply(sessionID, { system: name, systemManual: true }, metadata)
    return `System set to ${name}`
  }
  if (kind === "tone") {
    OpenCodezSession.apply(sessionID, { tone: name, toneManual: true }, metadata)
    return `Tone set to ${name}`
  }
  const template = await OpenCodezPromptLibrary.readTemplate(name)
  if (!template) throw new Error(`Nothing found for "${name}". Try another name.`)
  OpenCodezSession.apply(
    sessionID,
    {
      system: template.system,
      tone: template.tone,
      systemManual: true,
      toneManual: true,
    },
    metadata,
  )
  return `Template set to ${name}`
}

async function persistSelection(
  client: ReturnType<typeof useSDK>["client"],
  sessionID: string | undefined,
  metadata: Record<string, unknown> | undefined,
) {
  if (!sessionID) return
  const result = await client.session.update({
    sessionID,
    metadata: OpenCodezSession.metadataWithSessionState(metadata, sessionID),
  })
  if (result.error) throw new Error("Could not save OpenCodez session state")
}
