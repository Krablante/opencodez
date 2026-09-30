import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { OpenCodezPrompts } from "@opencode-ai/schema/opencodez-prompts"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { createPromptLibrary } from "./library"
import "./prompt-library.css"

type Pane = "editor" | "rules" | "import" | "export" | "reasoning"
type Props = {
  initialID?: string
  onUse?: (id: string) => Promise<void>
  onNavigate?: (guard: ((action: () => void) => void) | undefined) => void
  onClose?: () => void
  onSettingsBack?: () => void
}

export function PromptLibrary(props: Props) {
  const language = useLanguage()
  const source = useServerSDK()()
  const library = createPromptLibrary({ server: () => source })
  const dialog = useDialog()
  const t = (key: Parameters<typeof language.t>[0]) => language.t(key)
  const [state, setState] = createStore<{
    filter: string
    search: string
    modelSearch: string
    pane: Pane
    item?: OpenCodezPrompts.Item
    name: string
    description: string
    text: string
    revision: string
    busy: boolean
    error?: string
    saved: boolean
    mobileDetail: boolean
    confirm?: "unsaved" | "delete"
    rules: OpenCodezPrompts.Rule[]
    variants: OpenCodezPrompts.Variant[]
    preview?: OpenCodezPrompts.Preview
    includeRules: boolean
    exportIDs: string[]
    policyBase: string
    targets: "models" | "families"
    properties: boolean
    compactEditor: boolean
  }>({
    filter: "all",
    search: "",
    modelSearch: "",
    pane: "editor",
    name: "",
    description: "",
    text: "",
    revision: "0",
    busy: false,
    saved: false,
    mobileDetail: false,
    rules: [],
    variants: [],
    includeRules: false,
    exportIDs: [],
    policyBase: "",
    targets: "models",
    properties: false,
    compactEditor: false,
  })
  let file: HTMLInputElement | undefined
  let nameInput: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined
  let viewportFrame: HTMLElement | undefined
  let viewportUpdate: number | undefined
  let disposed = false
  let pending: (() => void) | undefined
  let reading = 0
  let opened = false
  const textDirty = () =>
    !!state.item &&
    ((!state.item.id && (!!state.name.trim() || !!state.text.trim())) ||
      state.text !== state.item.text ||
      state.name !== state.item.name ||
      state.description !== state.item.description)
  const dirty = () =>
    textDirty() ||
    (state.pane === "rules" && JSON.stringify(state.rules) !== state.policyBase) ||
    (state.pane === "reasoning" && JSON.stringify(state.variants) !== state.policyBase)
  const promptName = (id: string) =>
    id === "@builtin"
      ? t("opencodez.prompts.reset")
      : (library.state.data?.entries.find(
          (item) => item.id === id || item.id === `file:${id}` || item.id === `builtin:${id}`,
        )?.name ?? id)
  const personal = () => library.state.data?.rules.filter((rule) => rule.source === "user") ?? []
  const assignments = () =>
    [
      ...new Map(
        (library.state.data?.rules ?? []).map((rule) => [`${rule.scope}/${rule.providerID}/${rule.target}`, rule]),
      ).values(),
    ].filter((rule) => {
      if (rule.scope === "all" && rule.prompt === "@builtin") return false
      if (rule.prompt !== state.item?.id && rule.prompt !== "@builtin") return false
      if (rule.scope === "model")
        return library.state.data?.models.some(
          (model) =>
            model.providerID === rule.providerID &&
            model.id === rule.target &&
            model.effectivePrompt === state.item?.id,
        )
      if (rule.scope === "family")
        return library.state.data?.models.some(
          (model) =>
            model.providerID === rule.providerID &&
            model.family === rule.target &&
            model.effectivePrompt === state.item?.id,
        )
      return library.state.data?.models.some((model) => model.effectivePrompt === state.item?.id)
    })
  const entries = createMemo(() =>
    (library.state.data?.entries ?? []).filter((entry) => {
      if (state.filter === "deleted" ? !entry.deleted : entry.deleted) return false
      if (state.filter === "builtin" && entry.source !== "builtin") return false
      if (state.filter === "mine" && entry.source !== "library") return false
      return `${entry.name} ${entry.description} ${entry.id}`.toLowerCase().includes(state.search.toLowerCase())
    }),
  )

  const guard = (action: () => void) => {
    if (!dirty()) return action()
    pending = action
    setState("confirm", "unsaved")
  }
  const error = (value: unknown) => {
    const cause = value instanceof Error ? value.cause : undefined
    const body = typeof cause === "object" && cause !== null && "body" in cause ? cause.body : value
    const conflict = typeof body === "object" && body !== null && "code" in body && body.code === "conflict"
    setState("error", t(conflict ? "opencodez.prompts.conflict" : "opencodez.prompts.error"))
  }
  const open = async (id: string) => {
    const token = ++reading
    setState({ error: undefined, busy: true, pane: "editor" })
    try {
      const result = await library.server().client.opencodez.library.item({ id })
      if (reading !== token || !result.data) return
      const item = result.data
      setState({
        item,
        name: item.name,
        description: item.description,
        text: item.text,
        saved: false,
        mobileDetail: true,
        revision: library.state.data?.revision ?? "0",
        confirm: undefined,
        properties: false,
      })
    } catch (value) {
      error(value)
    } finally {
      if (reading === token) setState("busy", false)
    }
  }
  const create = (source?: OpenCodezPrompts.Item) => {
    const item: OpenCodezPrompts.Item = {
      id: "",
      name: source ? `${source.name} · ${t("opencodez.prompts.copiedName")}` : "",
      description: source?.description ?? "",
      text: source?.text ?? "",
      source: "library",
      deleted: false,
      version: "",
      sourceUpdated: false,
      origin: source?.id ? { id: source.id, version: source.version } : source?.origin,
    }
    setState({
      item,
      name: item.name,
      description: item.description,
      text: item.text,
      pane: "editor",
      mobileDetail: true,
      saved: false,
      error: undefined,
      revision: library.state.data?.revision ?? "0",
      properties: false,
    })
    requestAnimationFrame(() => nameInput?.focus())
  }
  const save = async () => {
    if (!state.item || state.busy || !state.name.trim() || !state.text.trim()) return false
    const id = state.item.id
    const before = new Set(library.state.data?.entries.map((entry) => entry.id))
    setState({ busy: true, error: undefined })
    try {
      const result = await library.update({
        action: "save",
        revision: state.revision,
        id: id || undefined,
        name: state.name,
        description: state.description,
        text: state.text,
        version: state.item.version,
        origin: state.item.origin,
      })
      const created = id || result.entries.find((item) => !before.has(item.id))?.id
      if (created) await open(created)
      setState("saved", true)
      return true
    } catch (value) {
      error(value)
      return false
    } finally {
      setState("busy", false)
    }
  }
  const status = async (action: "delete" | "restore") => {
    if (!state.item?.id) return
    setState({ busy: true, error: undefined, confirm: undefined })
    try {
      await library.update({ action, id: state.item.id })
      await open(state.item.id)
    } catch (value) {
      error(value)
    } finally {
      setState("busy", false)
    }
  }
  const panel = (pane: Pane) =>
    guard(() => {
      const rules = personal().map((rule) => ({ ...rule }))
      const variants = (library.state.data?.variants ?? []).map((rule) => ({ ...rule }))
      setState({
        pane,
        modelSearch: "",
        error: undefined,
        mobileDetail: true,
        revision: library.state.data?.revision ?? "0",
        rules,
        variants,
        policyBase: JSON.stringify(pane === "rules" ? rules : variants),
        targets: "models",
      })
    })
  const ruleKey = (rule: Pick<OpenCodezPrompts.Rule, "scope" | "providerID" | "target">) =>
    `${rule.scope}/${rule.providerID}/${rule.target}`
  const ruleFor = (scope: OpenCodezPrompts.Rule["scope"], providerID: string, target: string) =>
    state.rules.find((rule) => ruleKey(rule) === ruleKey({ scope, providerID, target }))
  const setRule = (scope: OpenCodezPrompts.Rule["scope"], providerID: string, target: string, prompt: string) => {
    let rest = state.rules.filter((rule) => ruleKey(rule) !== ruleKey({ scope, providerID, target }))
    const global =
      state.rules.find((rule) => rule.scope === "all")?.prompt ??
      library.state.data?.rules.findLast((rule) => rule.scope === "all")?.prompt
    if (scope !== "all" && global && global !== "@builtin")
      rest = [
        ...rest.filter((rule) => rule.scope !== "all"),
        { scope: "all", providerID: "", target: "", prompt: "@builtin" },
      ]
    setState("rules", prompt ? [...rest, { scope, providerID, target, prompt }] : rest)
  }
  const apply = async (action: "rules" | "variants") => {
    setState({ busy: true, error: undefined })
    try {
      await library.update({
        action,
        revision: state.revision,
        ...(action === "rules" ? { rules: state.rules } : { variants: state.variants }),
      })
      setState({ pane: "editor", saved: true, revision: library.state.data?.revision ?? state.revision })
      return true
    } catch (value) {
      error(value)
      return false
    } finally {
      setState("busy", false)
    }
  }
  const matchingModels = createMemo(() =>
    (library.state.data?.models ?? []).filter((model) =>
      `${model.name} ${model.id} ${model.providerName} ${model.family}`
        .toLowerCase()
        .includes(state.modelSearch.toLowerCase()),
    ),
  )
  const families = createMemo(() => [
    ...new Map(
      matchingModels()
        .filter((model) => !!model.family)
        .map((model) => [`${model.providerID}/${model.family}`, model]),
    ).values(),
  ])
  const currentRule = (scope: "family" | "model", providerID: string, target: string) => {
    const rule = library.state.data?.rules.findLast((rule) => ruleKey(rule) === ruleKey({ scope, providerID, target }))
    const model =
      scope === "model"
        ? library.state.data?.models.find((model) => model.providerID === providerID && model.id === target)
        : undefined
    return model?.effectivePrompt ? { scope, providerID, target, prompt: model.effectivePrompt } : rule
  }
  const targetGroups = createMemo(() => {
    const models = state.targets === "families" ? families() : matchingModels()
    return [...new Set(models.map((model) => model.providerID))].map((id) => ({
      id,
      name: models.find((model) => model.providerID === id)!.providerName,
      models: models.filter((model) => model.providerID === id),
    }))
  })
  const back = () =>
    guard(() => {
      if (state.pane !== "editor") setState("pane", "editor")
      else setState("mobileDetail", false)
    })
  const download = (name: string, value: string, type: string) => {
    const url = URL.createObjectURL(new Blob([value], { type }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const exportBundle = async () => {
    setState({ busy: true, error: undefined })
    try {
      const result = await library
        .server()
        .client.opencodez.library.export({ ids: state.exportIDs, includeRules: state.includeRules })
      download("opencodez-prompts.json", JSON.stringify(result.data, null, 2), "application/json")
    } catch (value) {
      error(value)
    } finally {
      setState("busy", false)
    }
  }
  const importFile = async (incoming: File) => {
    if (incoming.size > 32 * 1024 * 1024) {
      setState("error", t("opencodez.prompts.invalidFile"))
      return
    }
    setState({ busy: true, error: undefined })
    try {
      const text = await incoming.text()
      const bundle: unknown = /\.md$/i.test(incoming.name)
        ? {
            format: "opencodez-prompts",
            version: 1,
            items: [
              { id: `markdown:${incoming.name}`, name: incoming.name.replace(/\.md$/i, ""), description: "", text },
            ],
            rules: [],
          }
        : JSON.parse(text)
      const result = await library.server().client.opencodez.library.preview({ bundle })
      setState({
        preview: result.data,
        pane: "import",
        mobileDetail: true,
        includeRules: false,
        revision: library.state.data?.revision ?? "0",
      })
    } catch {
      setState("error", t("opencodez.prompts.invalidFile"))
    } finally {
      setState("busy", false)
      if (file) file.value = ""
    }
  }
  const importApply = async () => {
    if (!state.preview) return
    setState({ busy: true, error: undefined })
    try {
      await library.update({
        action: "import",
        revision: state.revision,
        items: state.preview.items,
        rules: state.includeRules ? state.preview.rules : [],
      })
      setState({ pane: "editor", preview: undefined, saved: true, mobileDetail: false })
    } catch (value) {
      error(value)
    } finally {
      setState("busy", false)
    }
  }
  createEffect(() => {
    if (opened || !library.state.data) return
    opened = true
    if (props.initialID) void open(props.initialID)
  })
  props.onNavigate?.(guard)
  let allowClose = false
  createEffect(() => {
    const active = dialog.active
    if (!active) return
    const stop = dialog.guardClose((resume) => {
      if (allowClose || !dirty()) return true
      guard(() => {
        allowClose = true
        resume()
      })
      return false
    })
    onCleanup(stop)
  })
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty()) {
      event.preventDefault()
      event.returnValue = ""
    }
  }
  window.addEventListener("beforeunload", beforeUnload)
  const resize = () => {
    if (disposed) return
    const frame = viewportFrame ?? root?.closest("[data-component='dialog-v2'], [data-component='dialog']")
    const height = window.visualViewport?.height ?? window.innerHeight
    if (frame instanceof HTMLElement) {
      viewportFrame = frame
      frame.setAttribute("data-oz-prompts", "")
      frame.style.setProperty("--oz-viewport-height", `${Math.round(height)}px`)
      frame.style.setProperty("--oz-viewport-top", `${Math.round(window.visualViewport?.offsetTop ?? 0)}px`)
    }
    const focused = document.activeElement
    setState(
      "compactEditor",
      focused instanceof HTMLTextAreaElement &&
        !!root?.contains(focused) &&
        (height < 500 || window.innerHeight - height > 120),
    )
  }
  const scheduleResize = () => {
    // Removing a focused node can emit focusout after the owner's cleanup.
    if (disposed) return
    if (viewportUpdate !== undefined) cancelAnimationFrame(viewportUpdate)
    viewportUpdate = requestAnimationFrame(() => {
      viewportUpdate = undefined
      resize()
    })
  }
  onMount(resize)
  window.visualViewport?.addEventListener("resize", scheduleResize)
  window.visualViewport?.addEventListener("scroll", scheduleResize)
  window.addEventListener("resize", scheduleResize)
  onCleanup(() => {
    disposed = true
    reading++
    window.removeEventListener("beforeunload", beforeUnload)
    props.onNavigate?.(undefined)
    window.visualViewport?.removeEventListener("resize", scheduleResize)
    window.visualViewport?.removeEventListener("scroll", scheduleResize)
    window.removeEventListener("resize", scheduleResize)
    if (viewportUpdate !== undefined) cancelAnimationFrame(viewportUpdate)
    const frame = viewportFrame
    if (frame instanceof HTMLElement) {
      frame.removeAttribute("data-oz-prompts")
      frame.style.removeProperty("--oz-viewport-height")
      frame.style.removeProperty("--oz-viewport-top")
    }
  })

  const ruleRow = (scope: "model" | "family", providerID: string, target: string, label: string) => (
    <div class="oz-rule" data-target={`${providerID}/${target}`}>
      <div class="oz-rule-label">
        <strong dir="auto">{label}</strong>
        <Show when={currentRule(scope, providerID, target)}>
          {(rule) => (
            <span>
              {t(
                ruleFor(scope, providerID, target)?.prompt !==
                  personal().find((entry) => ruleKey(entry) === ruleKey({ scope, providerID, target }))?.prompt
                  ? "opencodez.prompts.replaces"
                  : "opencodez.prompts.current",
              )}
              : <bdi>{promptName(rule().prompt)}</bdi>
            </span>
          )}
        </Show>
      </div>
      <select
        aria-label={`${label} · ${t("opencodez.prompts.defaults")}`}
        value={ruleFor(scope, providerID, target)?.prompt ?? ""}
        onChange={(event) => setRule(scope, providerID, target, event.currentTarget.value)}
      >
        <option value="">
          {personal().some((rule) => ruleKey(rule) === ruleKey({ scope, providerID, target }))
            ? t("opencodez.prompts.inheritShort")
            : t("opencodez.prompts.autoShort")}
        </option>
        <option value="@builtin">{t("opencodez.prompts.resetShort")}</option>
        <Show when={state.item?.id}>
          <option value={state.item?.id}>{t("opencodez.prompts.thisPrompt")}</option>
        </Show>
        <Show when={ruleFor(scope, providerID, target)}>
          {(rule) => (
            <Show when={rule().prompt !== state.item?.id && rule().prompt !== "@builtin"}>
              <option value={rule().prompt}>{promptName(rule().prompt)}</option>
            </Show>
          )}
        </Show>
      </select>
      <Show when={scope === "family"}>
        <details class="oz-family-coverage">
          <summary>
            {t("opencodez.prompts.coverage")} ·{" "}
            {
              library.state.data?.models.filter((model) => model.providerID === providerID && model.family === target)
                .length
            }
          </summary>
          <For
            each={library.state.data?.models.filter(
              (model) => model.providerID === providerID && model.family === target,
            )}
          >
            {(model) => (
              <div class="oz-coverage">
                <bdi>{model.name}</bdi>
                <Show
                  when={state.rules.some(
                    (rule) => rule.scope === "model" && rule.providerID === providerID && rule.target === model.id,
                  )}
                >
                  <span title={t("opencodez.prompts.exceptions")}>{t("opencodez.prompts.exception")}</span>
                </Show>
              </div>
            )}
          </For>
        </details>
      </Show>
    </div>
  )

  return (
    <div
      class="oz-library"
      ref={root}
      data-component="opencodez-prompt-library"
      data-detail={state.mobileDetail ? "true" : "false"}
      data-pane={state.pane}
      data-properties={state.properties}
      data-editing={state.compactEditor}
      onFocusIn={scheduleResize}
      onFocusOut={scheduleResize}
    >
      <input
        ref={file}
        hidden
        type="file"
        disabled={state.busy}
        accept=".json,.md,application/json,text/markdown"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0]
          if (selected) guard(() => void importFile(selected))
        }}
      />
      <header class="oz-header">
        <Show when={state.mobileDetail}>
          <button
            class="oz-header-back oz-icon"
            aria-label={t(state.pane === "editor" ? "opencodez.prompts.back" : "opencodez.prompts.backEditor")}
            onClick={back}
          >
            <Icon name="arrow-left" />
          </button>
        </Show>
        <Show when={props.onSettingsBack}>
          <button
            class="oz-settings-back oz-icon oz-list-action"
            aria-label={t("settings.tab.general")}
            onClick={() => props.onSettingsBack?.()}
          >
            <Icon name="arrow-left" />
          </button>
        </Show>
        <div class="oz-header-main">
          <h2 dir="auto">{state.compactEditor ? state.name : t("opencodez.prompts.title")}</h2>
          <span class="oz-server">
            <Icon name="server" size="small" />
            <bdi>{library.server().server.displayName ?? library.server().url}</bdi>
          </span>
        </div>
        <div class="oz-actions">
          <button
            type="button"
            class="oz-icon oz-list-action"
            aria-label={t("opencodez.prompts.create")}
            title={t("opencodez.prompts.create")}
            onClick={() => guard(() => create())}
          >
            <Icon name="plus" />
          </button>
          <button
            type="button"
            class="oz-icon oz-list-action"
            aria-label={t("opencodez.prompts.import")}
            title={t("opencodez.prompts.import")}
            onClick={() => guard(() => file?.click())}
          >
            <Icon name="arrow-up" />
          </button>
          <button
            type="button"
            class="oz-icon oz-desktop-action"
            aria-label={t("opencodez.prompts.exportAll")}
            title={t("opencodez.prompts.exportAll")}
            onClick={() => {
              setState(
                "exportIDs",
                library.state.data?.entries
                  .filter((entry) => entry.source === "library" && !entry.deleted)
                  .map((entry) => entry.id) ?? [],
              )
              panel("export")
            }}
          >
            <Icon name="download" />
          </button>
          <button
            type="button"
            class="oz-icon oz-desktop-action"
            aria-label={t("opencodez.prompts.reasoning")}
            title={t("opencodez.prompts.reasoning")}
            onClick={() => panel("reasoning")}
          >
            <Icon name="sliders" />
          </button>
          <details class="oz-more">
            <summary class="oz-icon" aria-label={t("opencodez.prompts.actions")}>
              <Icon name="dot-grid" />
            </summary>
            <div class="oz-more-menu">
              <Show when={state.pane === "editor" && state.mobileDetail && state.item}>
                {(item) => (
                  <>
                    <button
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open")
                        setState("properties", !state.properties)
                      }}
                    >
                      <Icon name="sliders" size="small" />
                      {t("opencodez.prompts.properties")}
                    </button>
                    <button
                      onClick={(event) => {
                        const original = item()
                        event.currentTarget.closest("details")?.removeAttribute("open")
                        guard(() => create(state.item ?? original))
                      }}
                    >
                      <Icon name="plus" size="small" />
                      {t("opencodez.prompts.copy")}
                    </button>
                    <button
                      disabled={!item().id}
                      onClick={(event) => {
                        event.currentTarget.closest("details")?.removeAttribute("open")
                        setState("exportIDs", [item().id])
                        panel("export")
                      }}
                    >
                      <Icon name="download" size="small" />
                      {t("opencodez.prompts.export")}
                    </button>
                    <Show when={item().source !== "builtin" && item().id}>
                      <button
                        class="oz-danger"
                        onClick={(event) => {
                          event.currentTarget.closest("details")?.removeAttribute("open")
                          if (item().deleted) void status("restore")
                          else setState("confirm", "delete")
                        }}
                      >
                        <Icon name={item().deleted ? "arrow-undo-down" : "trash"} size="small" />
                        {t(item().deleted ? "opencodez.prompts.restore" : "opencodez.prompts.delete")}
                      </button>
                    </Show>
                    <hr />
                  </>
                )}
              </Show>
              <Show when={state.mobileDetail}>
                <button
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open")
                    guard(() => create())
                  }}
                >
                  <Icon name="plus" size="small" />
                  {t("opencodez.prompts.create")}
                </button>
                <button
                  onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open")
                    guard(() => file?.click())
                  }}
                >
                  <Icon name="arrow-up" size="small" />
                  {t("opencodez.prompts.import")}
                </button>
              </Show>
              <button
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open")
                  setState(
                    "exportIDs",
                    library.state.data?.entries
                      .filter((entry) => entry.source === "library" && !entry.deleted)
                      .map((entry) => entry.id) ?? [],
                  )
                  panel("export")
                }}
              >
                <Icon name="download" size="small" />
                {t("opencodez.prompts.exportAll")}
              </button>
              <button
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open")
                  panel("reasoning")
                }}
              >
                <Icon name="sliders" size="small" />
                {t("opencodez.prompts.reasoning")}
              </button>
            </div>
          </details>
        </div>
        <Show when={props.onClose}>
          <button
            type="button"
            class="oz-icon"
            aria-label={t("opencodez.prompts.cancel")}
            onClick={() => props.onClose?.()}
          >
            <Icon name="close" />
          </button>
        </Show>
      </header>
      <Show when={state.error || library.state.error}>
        <div class="oz-alert" role="alert">
          <span>{state.error ?? library.state.error}</span>
          <button
            onClick={() =>
              guard(() => {
                setState("error", undefined)
                void library.load().then(() => {
                  if (state.item?.id) void open(state.item.id)
                })
              })
            }
          >
            {t("opencodez.prompts.refresh")}
          </button>
          <Show when={state.item?.source === "library"}>
            <button
              onClick={() => {
                const draft = { ...state.item!, name: state.name, description: state.description, text: state.text }
                create(draft)
              }}
            >
              {t("opencodez.prompts.copy")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={state.confirm}>
        <div
          class="oz-alert"
          role="alertdialog"
          aria-label={state.confirm === "delete" ? t("opencodez.prompts.delete") : t("opencodez.prompts.unsaved")}
        >
          <span>{t(state.confirm === "delete" ? "opencodez.prompts.deleteHint" : "opencodez.prompts.unsaved")}</span>
          <div class="oz-actions">
            <Show when={state.confirm === "unsaved"}>
              <button
                onClick={async () => {
                  const saved =
                    state.pane === "rules"
                      ? await apply("rules")
                      : state.pane === "reasoning"
                        ? await apply("variants")
                        : await save()
                  if (saved) {
                    setState("confirm", undefined)
                    pending?.()
                  }
                }}
              >
                {t("opencodez.prompts.save")}
              </button>
            </Show>
            <button
              class="oz-danger"
              onClick={() => {
                if (state.confirm === "delete") void status("delete")
                else {
                  const item = state.item?.id ? state.item : undefined
                  setState({
                    confirm: undefined,
                    item,
                    name: item?.name ?? "",
                    description: item?.description ?? "",
                    text: item?.text ?? "",
                  })
                  pending?.()
                }
              }}
            >
              {t(state.confirm === "delete" ? "opencodez.prompts.delete" : "opencodez.prompts.discard")}
            </button>
            <button onClick={() => setState("confirm", undefined)}>{t("opencodez.prompts.cancel")}</button>
          </div>
        </div>
      </Show>
      <div class="oz-body">
        <aside class="oz-list">
          <input
            type="search"
            aria-label={t("common.search.placeholder")}
            placeholder={t("common.search.placeholder")}
            value={state.search}
            onInput={(event) => setState("search", event.currentTarget.value)}
          />
          <div class="oz-filters" role="group">
            <For each={["all", "builtin", "mine", "deleted"] as const}>
              {(filter) => (
                <button aria-pressed={state.filter === filter} onClick={() => setState("filter", filter)}>
                  {t(`opencodez.prompts.${filter}`)}
                </button>
              )}
            </For>
          </div>
          <div class="oz-entries">
            <Show
              when={!library.state.loading || library.state.data}
              fallback={<p class="oz-muted">{t("common.loading")}</p>}
            >
              <For each={entries()} fallback={<p class="oz-muted">{t("palette.empty")}</p>}>
                {(entry) => (
                  <button
                    class="oz-entry"
                    data-selected={entry.id === state.item?.id}
                    onClick={() => guard(() => void open(entry.id))}
                  >
                    <span class="oz-entry-title">
                      <Icon name="prompt" size="small" />
                      <bdi dir="auto">{entry.name}</bdi>
                    </span>
                    <span class="oz-entry-meta">
                      {t(
                        entry.source === "builtin"
                          ? "opencodez.prompts.builtin"
                          : entry.id.startsWith("file:")
                            ? "opencodez.prompts.file"
                            : "opencodez.prompts.mine",
                      )}
                      <Show
                        when={library.state.data?.models.filter((model) => model.effectivePrompt === entry.id).length}
                      >
                        {(count) => <span> · {count()}</span>}
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </aside>
        <section class="oz-detail">
          <button class="oz-back" onClick={back}>
            <Icon name="arrow-left" size="small" />
            {t("opencodez.prompts.back")}
          </button>
          <Show when={state.pane === "editor"}>
            <Show
              when={state.item}
              fallback={
                <div class="oz-empty">
                  <Icon name="prompt" />
                  <p>{t("opencodez.prompts.empty")}</p>
                  <button class="oz-primary" onClick={() => create()}>
                    {t("opencodez.prompts.create")}
                  </button>
                </div>
              }
            >
              {(item) => (
                <>
                  <div class="oz-editor-head">
                    <Show
                      when={item().source === "builtin"}
                      fallback={
                        <input
                          ref={nameInput}
                          class="oz-name"
                          aria-label={t("opencodez.prompts.name")}
                          placeholder={t("opencodez.prompts.name")}
                          value={state.name}
                          onInput={(event) => setState({ name: event.currentTarget.value, saved: false })}
                        />
                      }
                    >
                      <h3 dir="auto">{item().name}</h3>
                    </Show>
                    <span class="oz-badge">
                      {t(
                        item().source === "builtin"
                          ? "opencodez.prompts.builtin"
                          : item().id.startsWith("file:")
                            ? "opencodez.prompts.file"
                            : "opencodez.prompts.mine",
                      )}
                    </span>
                    <button
                      class="oz-icon oz-properties-toggle"
                      aria-label={t("opencodez.prompts.properties")}
                      aria-expanded={state.properties}
                      onClick={() => setState("properties", !state.properties)}
                    >
                      <Icon name="chevron-down" size="small" />
                    </button>
                  </div>
                  <div class="oz-properties">
                    <Show when={item().source !== "builtin"}>
                      <input
                        class="oz-description"
                        aria-label={t("opencodez.prompts.description")}
                        placeholder={t("opencodez.prompts.description")}
                        value={state.description}
                        onInput={(event) => setState({ description: event.currentTarget.value, saved: false })}
                      />
                    </Show>
                    <p class="oz-hint">{t("opencodez.prompts.coreHint")}</p>
                  </div>
                  <Show when={item().deleted}>
                    <p class="oz-muted">{t("opencodez.prompts.deletedHint")}</p>
                  </Show>
                  <Show when={item().sourceUpdated}>
                    <div class="oz-source">
                      <span>{t("opencodez.prompts.sourceUpdated")}</span>
                      <button
                        onClick={() =>
                          guard(() => {
                            if (item().origin) void open(item().origin!.id)
                          })
                        }
                      >
                        {t("opencodez.prompts.viewSource")}
                      </button>
                    </div>
                  </Show>
                  <textarea
                    class="oz-text"
                    aria-label={t("opencodez.prompts.text")}
                    placeholder={t("opencodez.prompts.placeholder")}
                    readOnly={item().source === "builtin" || item().deleted}
                    spellcheck={false}
                    dir="auto"
                    value={state.text}
                    onInput={(event) => setState({ text: event.currentTarget.value, saved: false })}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
                        event.preventDefault()
                        if (item().source !== "builtin") void save()
                      }
                    }}
                  />
                  <button
                    class="oz-defaults"
                    disabled={!item().id || item().deleted}
                    aria-label={t("opencodez.prompts.assign")}
                    onClick={() => panel("rules")}
                  >
                    <Icon name="sliders" size="small" />
                    <span class="oz-defaults-label">{t("opencodez.prompts.defaults")}</span>
                    <span class="oz-assignment-summary">
                      <Show
                        when={assignments().length}
                        fallback={<span class="oz-muted">{t("opencodez.prompts.unassignedShort")}</span>}
                      >
                        <For each={assignments().slice(0, 1)}>
                          {(rule) => (
                            <bdi class="oz-chip">
                              {rule.scope === "all"
                                ? t("opencodez.prompts.global")
                                : rule.scope === "fallback"
                                  ? t("opencodez.prompts.fallback")
                                  : rule.target}
                            </bdi>
                          )}
                        </For>
                        <Show when={assignments().length > 1}>+{assignments().length - 1}</Show>
                      </Show>
                    </span>
                    <Icon name="chevron-right" size="small" />
                  </button>
                  <footer class="oz-footer oz-editor-footer">
                    <div class="oz-actions">
                      <Show when={item().source !== "builtin" && !item().deleted}>
                        <button
                          class="oz-primary"
                          disabled={state.busy || !state.name.trim() || !state.text.trim() || (!!item().id && !dirty())}
                          onClick={() => void save()}
                        >
                          {t(state.saved && !dirty() ? "opencodez.prompts.savedShort" : "opencodez.prompts.save")}
                        </button>
                      </Show>
                      <button
                        class={item().source === "builtin" ? "oz-copy-action" : "oz-desktop-action"}
                        disabled={state.busy}
                        onClick={() => {
                          const original = item()
                          guard(() => create(state.item ?? original))
                        }}
                      >
                        {t("opencodez.prompts.copy")}
                      </button>
                      <button
                        class="oz-icon oz-desktop-action"
                        disabled={!item().id}
                        aria-label={t("opencodez.prompts.export")}
                        onClick={() => {
                          setState("exportIDs", [item().id])
                          panel("export")
                        }}
                      >
                        <Icon name="download" />
                      </button>
                      <Show when={item().source !== "builtin" && item().id}>
                        <button
                          class="oz-icon oz-desktop-action"
                          aria-label={t(item().deleted ? "opencodez.prompts.restore" : "opencodez.prompts.delete")}
                          onClick={() => (item().deleted ? void status("restore") : setState("confirm", "delete"))}
                        >
                          <Icon name={item().deleted ? "arrow-undo-down" : "trash"} />
                        </button>
                      </Show>
                    </div>
                    <Show when={props.onUse && !item().deleted}>
                      <button
                        class="oz-use-action"
                        disabled={state.busy || !state.name.trim() || !state.text.trim()}
                        onClick={async () => {
                          if (dirty() && !(await save())) return
                          if (state.item?.id) await props.onUse?.(state.item.id)
                        }}
                      >
                        <span class="oz-desktop-copy">
                          {t(dirty() ? "opencodez.prompts.saveUse" : "opencodez.prompts.use")}
                        </span>
                        <span class="oz-mobile-copy">
                          {t(dirty() ? "opencodez.prompts.saveUseShort" : "opencodez.prompts.useShort")}
                        </span>
                      </button>
                    </Show>
                    <span class="oz-save-status" role="status">
                      {state.busy
                        ? t("common.loading")
                        : dirty()
                          ? t("opencodez.prompts.unsaved")
                          : state.saved
                            ? t("opencodez.prompts.saved")
                            : ""}
                    </span>
                  </footer>
                </>
              )}
            </Show>
          </Show>
          <Show when={state.pane === "rules"}>
            <div class="oz-pane">
              <h3>
                {t("opencodez.prompts.defaults")} · <bdi>{state.item?.name}</bdi>
              </h3>
              <input
                type="search"
                placeholder={t("dialog.model.search.placeholder")}
                aria-label={t("dialog.model.search.placeholder")}
                value={state.modelSearch}
                onInput={(event) => setState("modelSearch", event.currentTarget.value)}
              />
              <div class="oz-target-tabs" role="group" aria-label={t("opencodez.prompts.defaults")}>
                <button aria-pressed={state.targets === "models"} onClick={() => setState("targets", "models")}>
                  {t("opencodez.prompts.models")}
                </button>
                <button aria-pressed={state.targets === "families"} onClick={() => setState("targets", "families")}>
                  {t("opencodez.prompts.families")}
                </button>
              </div>
              <Show
                when={
                  (state.rules.find((rule) => rule.scope === "all")?.prompt ??
                    library.state.data?.rules.findLast((rule) => rule.scope === "all")?.prompt) !== "@builtin" &&
                  !!(
                    state.rules.find((rule) => rule.scope === "all") ??
                    library.state.data?.rules.findLast((rule) => rule.scope === "all")
                  )
                }
              >
                <div class="oz-alert">
                  <span>{t("opencodez.prompts.globalHint")}</span>
                  <button
                    onClick={() =>
                      setState("rules", [
                        ...state.rules.filter((rule) => rule.scope !== "all"),
                        { scope: "all", providerID: "", target: "", prompt: "@builtin" },
                      ])
                    }
                  >
                    {t("opencodez.prompts.removeGlobal")}
                  </button>
                </div>
              </Show>
              <div class="oz-scroll">
                <Show
                  when={
                    state.rules.some((rule) => rule.scope === "all" && rule.prompt === "@builtin") &&
                    library.state.data?.rules.some((rule) => rule.scope === "all" && rule.prompt !== "@builtin")
                  }
                >
                  <p class="oz-hint">{t("opencodez.prompts.globalWillReset")}</p>
                </Show>
                <For each={targetGroups()} fallback={<p class="oz-muted">{t("palette.empty")}</p>}>
                  {(group) => (
                    <>
                      <h4 class="oz-provider-heading">
                        <bdi>{group.name}</bdi>
                        <span>{group.models.length}</span>
                      </h4>
                      <For each={group.models}>
                        {(model) =>
                          state.targets === "families"
                            ? ruleRow("family", model.providerID, model.family, model.family)
                            : ruleRow("model", model.providerID, model.id, model.name)
                        }
                      </For>
                    </>
                  )}
                </For>
                <details class="oz-other-defaults">
                  <summary>{t("opencodez.prompts.otherDefaults")}</summary>
                  <For each={["all", "fallback"] as const}>
                    {(scope) => (
                      <div class="oz-rule">
                        <div class="oz-rule-label">
                          <strong>
                            {t(scope === "all" ? "opencodez.prompts.global" : "opencodez.prompts.fallback")}
                          </strong>
                        </div>
                        <select
                          aria-label={t(scope === "all" ? "opencodez.prompts.global" : "opencodez.prompts.fallback")}
                          value={ruleFor(scope, "", "")?.prompt ?? ""}
                          onChange={(event) => setRule(scope, "", "", event.currentTarget.value)}
                        >
                          <option value="">{t("opencodez.prompts.inherit")}</option>
                          <option value="@builtin">{t("opencodez.prompts.reset")}</option>
                          <Show when={state.item?.id}>
                            <option value={state.item?.id}>{state.item?.name}</option>
                          </Show>
                          <Show when={ruleFor(scope, "", "")}>
                            {(rule) => (
                              <Show when={rule().prompt !== state.item?.id && rule().prompt !== "@builtin"}>
                                <option value={rule().prompt}>{promptName(rule().prompt)}</option>
                              </Show>
                            )}
                          </Show>
                        </select>
                      </div>
                    )}
                  </For>
                </details>
              </div>
              <footer class="oz-footer">
                <button
                  class="oz-primary"
                  disabled={state.busy || JSON.stringify(state.rules) === state.policyBase}
                  onClick={() => void apply("rules")}
                >
                  <span class="oz-desktop-copy">{t("opencodez.prompts.apply")}</span>
                  <span class="oz-mobile-copy">{t("opencodez.prompts.applyShort")}</span>
                </button>
                <button onClick={() => setState("pane", "editor")}>{t("opencodez.prompts.cancel")}</button>
              </footer>
            </div>
          </Show>
          <Show when={state.pane === "reasoning"}>
            <div class="oz-pane">
              <h3>{t("opencodez.prompts.reasoning")}</h3>
              <p class="oz-hint">{t("opencodez.prompts.reasoningHint")}</p>
              <input
                type="search"
                aria-label={t("dialog.model.search.placeholder")}
                placeholder={t("dialog.model.search.placeholder")}
                value={state.modelSearch}
                onInput={(event) => setState("modelSearch", event.currentTarget.value)}
              />
              <div class="oz-scroll">
                <For each={matchingModels().filter((model) => model.variants.length)}>
                  {(model) => (
                    <div class="oz-rule">
                      <div class="oz-rule-label">
                        <strong dir="auto">{model.name}</strong>
                        <span>{model.providerName}</span>
                      </div>
                      <select
                        aria-label={`${model.name} · ${t("opencodez.prompts.reasoning")}`}
                        value={
                          state.variants.find(
                            (entry) => entry.providerID === model.providerID && entry.modelID === model.id,
                          )?.variant ?? ""
                        }
                        onChange={(event) => {
                          const variant = event.currentTarget.value
                          setState("variants", [
                            ...state.variants.filter(
                              (entry) => entry.providerID !== model.providerID || entry.modelID !== model.id,
                            ),
                            ...(variant ? [{ providerID: model.providerID, modelID: model.id, variant }] : []),
                          ])
                        }}
                      >
                        <option value="">{t("opencodez.prompts.providerDefault")}</option>
                        <For each={model.variants}>{(variant) => <option value={variant}>{variant}</option>}</For>
                      </select>
                    </div>
                  )}
                </For>
              </div>
              <footer class="oz-footer">
                <button
                  class="oz-primary"
                  disabled={state.busy || JSON.stringify(state.variants) === state.policyBase}
                  onClick={() => void apply("variants")}
                >
                  <span class="oz-desktop-copy">{t("opencodez.prompts.saveReasoning")}</span>
                  <span class="oz-mobile-copy">{t("opencodez.prompts.save")}</span>
                </button>
                <button onClick={() => setState("pane", "editor")}>{t("opencodez.prompts.cancel")}</button>
              </footer>
            </div>
          </Show>
          <Show when={state.pane === "export"}>
            <div class="oz-pane">
              <h3>{t("opencodez.prompts.export")}</h3>
              <div class="oz-scroll">
                <For each={library.state.data?.entries.filter((item) => !item.deleted)}>
                  {(entry) => (
                    <label class="oz-check">
                      <input
                        type="checkbox"
                        checked={state.exportIDs.includes(entry.id)}
                        onChange={(event) =>
                          setState(
                            "exportIDs",
                            event.currentTarget.checked
                              ? [...state.exportIDs, entry.id]
                              : state.exportIDs.filter((id) => id !== entry.id),
                          )
                        }
                      />
                      <bdi>{entry.name}</bdi>
                    </label>
                  )}
                </For>
              </div>
              <label class="oz-check">
                <input
                  type="checkbox"
                  checked={state.includeRules}
                  onChange={(event) => setState("includeRules", event.currentTarget.checked)}
                />
                {t("opencodez.prompts.includeRules")}
              </label>
              <footer class="oz-footer">
                <button
                  class="oz-primary"
                  disabled={state.busy || !state.exportIDs.length}
                  onClick={() => void exportBundle()}
                >
                  {t("opencodez.prompts.bundle")}
                </button>
                <Show when={state.exportIDs.length === 1}>
                  <button
                    onClick={async () => {
                      const result = await library.server().client.opencodez.library.item({ id: state.exportIDs[0] })
                      if (result.data)
                        download(
                          `${result.data.name.replace(/[^\p{L}\p{N}_. -]/gu, "_")}.md`,
                          result.data.text,
                          "text/markdown",
                        )
                    }}
                  >
                    {t("opencodez.prompts.markdown")}
                  </button>
                </Show>
                <button onClick={() => setState("pane", "editor")}>{t("opencodez.prompts.cancel")}</button>
              </footer>
            </div>
          </Show>
          <Show when={state.pane === "import" && state.preview}>
            {(preview) => (
              <div class="oz-pane">
                <h3>{t("opencodez.prompts.importPreview")}</h3>
                <div class="oz-scroll">
                  <For each={state.preview?.items}>
                    {(entry, index) => (
                      <div class="oz-import-item">
                        <div>
                          <strong dir="auto">{entry.name}</strong>
                          <span class="oz-muted">{t(`opencodez.prompts.${entry.status}`)}</span>
                        </div>
                        <select
                          aria-label={entry.name}
                          value={entry.mode}
                          onChange={(event) => {
                            const mode = event.currentTarget.value
                            if (mode !== "keep" && mode !== "replace" && mode !== "copy") return
                            setState("preview", (preview) =>
                              preview
                                ? {
                                    ...preview,
                                    items: preview.items.map((item, row) =>
                                      row === index() ? { ...item, mode } : item,
                                    ),
                                  }
                                : undefined,
                            )
                          }}
                        >
                          <option value="keep">{t("opencodez.prompts.keep")}</option>
                          <Show when={entry.replaceable}>
                            <option value="replace">{t("opencodez.prompts.replace")}</option>
                          </Show>
                          <option value="copy">{t("opencodez.prompts.importCopy")}</option>
                        </select>
                        <details>
                          <summary>{t("opencodez.prompts.text")}</summary>
                          <pre dir="auto">{entry.text}</pre>
                        </details>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={state.preview?.rules.length}>
                  <label class="oz-check">
                    <input
                      type="checkbox"
                      checked={state.includeRules}
                      onChange={(event) => setState("includeRules", event.currentTarget.checked)}
                    />
                    {t("opencodez.prompts.importRules")}
                  </label>
                  <Show when={state.includeRules}>
                    <div class="oz-import-rules">
                      <p class="oz-hint">{t("opencodez.prompts.importRulesHint")}</p>
                      <For each={state.preview?.rules}>
                        {(rule) => (
                          <div>
                            <bdi>{rule.target || t("opencodez.prompts.global")}</bdi> →{" "}
                            <bdi>
                              {state.preview?.items.find((entry) => entry.id === rule.prompt)?.name ??
                                promptName(rule.prompt)}
                            </bdi>
                            <Show
                              when={currentRule(
                                rule.scope === "family" ? "family" : "model",
                                rule.providerID,
                                rule.target,
                              )}
                            >
                              {(old) => (
                                <span>
                                  {" "}
                                  · {t("opencodez.prompts.replaces")}: {promptName(old().prompt)}
                                </span>
                              )}
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
                <footer class="oz-footer">
                  <button class="oz-primary" disabled={state.busy} onClick={() => void importApply()}>
                    {t("opencodez.prompts.importApply")}
                  </button>
                  <button onClick={() => setState("pane", "editor")}>{t("opencodez.prompts.cancel")}</button>
                </footer>
              </div>
            )}
          </Show>
        </section>
      </div>
    </div>
  )
}

export function DialogPromptLibrary(props: Props) {
  const dialog = useDialog()
  return (
    <Dialog size="x-large" class="oz-library-dialog" containerClass="oz-library-frame">
      <PromptLibrary
        {...props}
        onClose={() => dialog.close()}
        onUse={
          props.onUse
            ? async (id) => {
                await props.onUse?.(id)
                dialog.close()
              }
            : undefined
        }
      />
    </Dialog>
  )
}
