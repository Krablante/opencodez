import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpenCodezPrompts } from "@opencode-ai/schema/opencodez-prompts"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"

export function createPromptLibrary(options?: { server?: Accessor<ServerSDK> }) {
  const current = useServerSDK()
  const server = options?.server ?? current
  const language = useLanguage()
  const [state, setState] = createStore<{ data?: OpenCodezPrompts.Catalog; loading: boolean; error?: string }>({
    loading: false,
  })
  let request = 0
  const load = async () => {
    const current = ++request
    setState({ loading: true, error: undefined })
    try {
      const result = await server().client.opencodez.library.get()
      if (request === current && result.data) setState("data", result.data)
    } catch {
      if (request === current) setState("error", language.t("common.requestFailed"))
    } finally {
      if (request === current) setState("loading", false)
    }
  }
  createEffect(() => {
    const sdk = server()
    setState("data", undefined)
    void load()
    const stop = sdk.event.listen((event) => {
      if (event.details.type === "opencodez.prompts.changed" || event.details.type === "server.connected") void load()
    })
    const resume = () => {
      if (document.visibilityState === "visible") void load()
    }
    document.addEventListener("visibilitychange", resume)
    onCleanup(() => {
      stop()
      document.removeEventListener("visibilitychange", resume)
      request++
    })
  })
  return {
    state,
    server,
    load,
    async update(command: Omit<OpenCodezPrompts.Command, "revision"> & { revision?: string }) {
      const revision = command.revision ?? state.data?.revision
      if (revision === undefined) throw new Error(language.t("common.requestFailed"))
      const result = await server().client.opencodez.library.update({
        openCodezPromptsCommand: {
          ...command,
          revision,
          rules: command.rules?.map((rule) => ({ ...rule })),
          variants: command.variants?.map((rule) => ({ ...rule })),
          items: command.items?.map((item) => ({ ...item })),
        },
      })
      if (!result.data) throw new Error(language.t("common.requestFailed"))
      setState("data", result.data)
      return result.data
    },
  }
}
