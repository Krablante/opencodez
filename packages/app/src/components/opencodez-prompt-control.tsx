import { Icon } from "@opencode-ai/ui/icon"
import type {
  OpenCodezPromptEntry,
  OpenCodezPromptModel,
  OpenCodezPromptState,
} from "@opencode-ai/sdk/v2/client"
import { For, Show, createEffect, createMemo, on, onCleanup, type Accessor, type Component, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

type Options = {
  sessionID: Accessor<string | undefined>
  sessionMetadata: Accessor<Record<string, unknown> | undefined>
  model: Accessor<OpenCodezPromptModel | undefined>
  restoreFocus: () => void
  style?: Accessor<JSX.CSSProperties | undefined>
}

type State = {
  open: boolean
  search: string
  loading: boolean
  loaded: boolean
  error?: string
  entries: OpenCodezPromptEntry[]
  prompt?: OpenCodezPromptState
  metadata: Record<string, unknown>
  left: number
  bottom: number
}

export function createOpenCodezPromptControl(options: Options): {
  metadata: Accessor<Record<string, unknown>>
  Control: Component
} {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<State>({
    open: false,
    search: "",
    loading: false,
    loaded: false,
    entries: [],
    metadata: {},
    left: 8,
    bottom: 8,
  })
  let search: HTMLInputElement | undefined
  let trigger: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  let request = 0

  const refresh = async () => {
    const current = ++request
    const sessionID = options.sessionID()
    const result = await sdk()
      .client.opencodez.prompt.state({
        sessionID,
        metadata: sessionID ? undefined : state.metadata,
        model: options.model(),
      })
      .then((value) => value.data ?? undefined)
      .catch(() => undefined)
    if (!result || current !== request) return
    setState("prompt", result.state)
    if (!sessionID) setState("metadata", result.metadata)
  }

  createEffect(
    on(
      () =>
        [
          options.sessionID(),
          options.sessionID() ? JSON.stringify(options.sessionMetadata() ?? {}) : "",
          JSON.stringify(options.model() ?? {}),
        ] as const,
      () => void refresh(),
    ),
  )

  createEffect(
    on(
      options.sessionID,
      (id) => {
        if (id) setState("metadata", {})
      },
      { defer: true },
    ),
  )

  const load = async () => {
    if (state.loaded || state.loading) return
    setState({ loading: true, error: undefined })
    const entries = await sdk()
      .client.opencodez.prompt.list()
      .then((value) => value.data ?? undefined)
      .catch(() => undefined)
    setState("loading", false)
    if (!entries) {
      setState("error", language.t("common.requestFailed"))
      return
    }
    setState({ entries, loaded: true })
  }

  const position = () => {
    const rect = trigger?.getBoundingClientRect()
    if (!rect) return
    setState({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)),
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
    })
  }

  const setOpen = (open: boolean, restore = true) => {
    if (open) position()
    setState("open", open)
    if (open) {
      void load()
      requestAnimationFrame(() => search?.focus())
      return
    }
    setState("search", "")
    if (restore) options.restoreFocus()
  }

  createEffect(
    on(
      () => state.open,
      (open) => {
        if (!open) return
        const pointer = (event: PointerEvent) => {
          const target = event.target
          if (!(target instanceof Node)) return
          if (trigger?.contains(target) || menu?.contains(target)) return
          setOpen(false, false)
        }
        const key = (event: KeyboardEvent) => {
          if (event.key === "Escape") setOpen(false)
        }
        document.addEventListener("pointerdown", pointer)
        document.addEventListener("keydown", key)
        window.addEventListener("resize", position)
        window.addEventListener("scroll", position, true)
        onCleanup(() => {
          document.removeEventListener("pointerdown", pointer)
          document.removeEventListener("keydown", key)
          window.removeEventListener("resize", position)
          window.removeEventListener("scroll", position, true)
        })
      },
    ),
  )

  const select = async (name: string) => {
    const sessionID = options.sessionID()
    const result = await sdk()
      .client.opencodez.prompt.select({
        sessionID,
        metadata: sessionID ? undefined : state.metadata,
        model: options.model(),
        name,
      })
      .then((value) => value.data ?? undefined)
      .catch(() => undefined)
    if (!result) return
    setState("prompt", result.state)
    if (!sessionID) setState("metadata", result.metadata)
    setOpen(false)
  }

  const entries = createMemo(() => {
    const query = state.search.trim().toLowerCase()
    return [{ name: "none", source: "builtin" as const }, ...state.entries].filter((entry) => {
      const label = entry.name === "none" ? "None" : entry.name
      return !query || label.toLowerCase().includes(query)
    })
  })

  const Control: Component = () => (
    <>
      <button
        ref={trigger}
        type="button"
        data-action="prompt-system"
        class="h-6 min-w-0 max-w-[200px] px-2 flex items-center gap-1 rounded-md text-12-regular text-text-weak hover:text-text-strong hover:bg-surface-base-hover"
        style={options.style?.()}
        aria-label="Select System prompt"
        aria-expanded={state.open}
        onClick={() => setOpen(!state.open)}
      >
        <Icon name="prompt" size="small" />
        <span class="truncate">S: {state.prompt?.system ?? "default"}</span>
        <Icon name="chevron-down" size="small" />
      </button>
      <Show when={state.open}>
        <Portal>
          <div
            ref={menu}
            role="dialog"
            aria-label="Select System prompt"
            class="fixed z-50 w-72 overflow-hidden rounded-md border border-border-weak-base bg-background-base shadow-lg"
            style={{ left: `${state.left}px`, bottom: `${state.bottom}px` }}
          >
          <div class="p-2 border-b border-border-weak-base">
            <input
              ref={search}
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
              placeholder="Search system prompts..."
              class="w-full h-8 px-2 rounded-md bg-surface-base text-13-regular text-text-strong outline-none placeholder:text-text-weaker"
            />
          </div>
          <div class="max-h-[244px] overflow-y-auto p-1">
            <Show when={!state.loading} fallback={<div class="px-2 py-1.5 text-13-regular text-text-weak">Loading...</div>}>
              <Show when={!state.error} fallback={<div class="px-2 py-1.5 text-13-regular text-text-weak">{state.error}</div>}>
                <Show
                  when={entries().length > 0}
                  fallback={<div class="px-2 py-1.5 text-13-regular text-text-weak">No prompts found</div>}
                >
                  <For each={entries()}>
                    {(entry) => {
                      const label = entry.name === "none" ? "None" : entry.name
                      return (
                        <button
                          type="button"
                          class="w-full px-2 py-1.5 flex items-center gap-2 rounded-md text-left text-13-regular text-text-strong hover:bg-surface-base-hover"
                          onClick={() => void select(entry.name)}
                        >
                          <Icon name="prompt" size="small" />
                          <span class="min-w-0 flex-1 truncate">{label}</span>
                          <Show when={entry.name === state.prompt?.system}>
                            <Icon name="check" size="small" />
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </Show>
              </Show>
            </Show>
          </div>
          </div>
        </Portal>
      </Show>
    </>
  )

  return {
    metadata: () => state.metadata,
    Control,
  }
}
