import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { OpenCodezSettings } from "@opencode-ai/core/opencodez/settings"
import type { Config, OpenCodezPromptEntry } from "@opencode-ai/sdk/v2"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export function OpenCodezPromptSelector(props: {
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
    return indicator.system
  })
  const options = createMemo(() => {
    const prompts = props.entries.map((item) => ({
      title: item.name,
      value: item.name,
      description: item.source,
    }))
    return [
      {
        title: "None",
        value: OpenCodezSession.noneID,
        description: "Disable System prompt for this session",
      },
      ...prompts,
    ]
  })

  return (
    <DialogSelect
      title="Select System"
      placeholder="Type to filter"
      current={current()}
      flat
      options={options()}
      onSelect={(option) => {
        void applySelection(sdk.client, option.value, props.sessionID, props.metadata, props.model)
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

async function applySelection(
  client: ReturnType<typeof useSDK>["client"],
  name: string,
  sessionID: string | undefined,
  metadata: Record<string, unknown> | undefined,
  model: OpenCodezSettings.ModelLike | undefined,
) {
  const result = await client.opencodez.prompt.select({
    sessionID,
    metadata: sessionID ? undefined : metadata,
    model: modelPayload(model),
    name,
  })
  if (result.error || !result.data) throw new Error(`Nothing found for "${name}". Try another name.`)
  if (sessionID) OpenCodezSession.hydrate(sessionID, result.data.metadata)
  else {
    const state = OpenCodezSession.fromMetadata(result.data.metadata)
    OpenCodezSession.resetPending(state.selection ?? {})
  }

  return `System set to ${OpenCodezSession.isNone(name) ? "None" : name}`
}

function modelPayload(model: OpenCodezSettings.ModelLike | undefined) {
  if (typeof model === "string") return { id: model }
  return model
}
