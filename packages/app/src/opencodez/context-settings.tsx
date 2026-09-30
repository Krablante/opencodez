import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { OpenCodezContext } from "@opencode-ai/schema/opencodez-context"
import { useServerSDK } from "@/context/server-sdk"
import { useLanguage } from "@/context/language"
import "./context-settings.css"

type Target = OpenCodezContext.Target & { name: string; providerName: string }
const key = (target: OpenCodezContext.Target) => JSON.stringify([target.scope, target.providerID, target.target])
const number = (value: string) => {
  const digits = value.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)))
  const grouped = digits.replace(/[\s_]/g, "")
  const text = /^\d{1,3}(?:[,.'’٬]\d{3})+$/.test(grouped) ? grouped.replace(/[,.'’٬]/g, "") : grouped
  if (!text) return undefined
  if (!/^\d+$/.test(text)) return NaN
  const result = Number(text)
  return Number.isSafeInteger(result) && result > 0 ? result : NaN
}
const ruleValues = (rule?: OpenCodezContext.Values) => ({
  ...(rule?.contextWindow === undefined ? {} : { contextWindow: rule.contextWindow }),
  ...(rule?.tokenLimit === undefined ? {} : { tokenLimit: rule.tokenLimit }),
  ...(rule?.auto === undefined ? {} : { auto: rule.auto }),
})

export function ContextSettings(props: {
  onNavigate?: (guard: ((action: () => void) => void) | undefined) => void
  onSettingsBack: () => void
}) {
  const source = useServerSDK()()
  const language = useLanguage()
  const dialog = useDialog()
  const t = (name: Parameters<typeof language.t>[0]) => language.t(name)
  const format = (value?: number) =>
    value === undefined ? "—" : value.toLocaleString("en-US").replaceAll(",", "\u202f")
  const [state, setState] = createStore<{
    data?: OpenCodezContext.Catalog
    resolved?: OpenCodezContext.Catalog
    loading: boolean
    busy: boolean
    error?: string
    conflict: boolean
    scope: "model" | "family"
    search: string
    selected?: Target
    window: string
    limit: string
    auto?: boolean
    revision: string
    base: string
    saved: boolean
    detail: boolean
    pane: "editor" | "import" | "export"
    preview?: OpenCodezContext.Preview
    checked: string[]
    confirm: boolean
  }>({
    loading: false,
    busy: false,
    conflict: false,
    scope: "model",
    search: "",
    window: "",
    limit: "",
    revision: "0",
    base: "{}",
    saved: false,
    detail: false,
    pane: "editor",
    checked: [],
    confirm: false,
  })
  let root: HTMLDivElement | undefined
  let file: HTMLInputElement | undefined
  let frame: HTMLElement | undefined
  let viewportUpdate: number | undefined
  let loading = 0
  let resolving = 0
  let disposed = false
  let pending: (() => void) | undefined
  let allowClose = false

  const values = createMemo(() => ({
    ...(number(state.window) === undefined ? {} : { contextWindow: number(state.window) }),
    ...(number(state.limit) === undefined ? {} : { tokenLimit: number(state.limit) }),
    ...(state.auto === undefined ? {} : { auto: state.auto }),
  }))
  const dirty = () => !!state.selected && state.pane === "editor" && JSON.stringify(values()) !== state.base
  const invalid = () => {
    const current = values()
    if (Number.isNaN(current.contextWindow) || Number.isNaN(current.tokenLimit)) return t("opencodez.context.invalid")
    if (
      current.contextWindow !== undefined &&
      current.tokenLimit !== undefined &&
      current.tokenLimit >= current.contextWindow
    )
      return t("opencodez.context.order")
    return undefined
  }
  const command = () => {
    const selected = state.selected
    if (!selected) return { rules: [], remove: [] }
    const target: OpenCodezContext.Target = {
      scope: selected.scope,
      providerID: selected.providerID,
      target: selected.target,
    }
    return Object.keys(values()).length
      ? { rules: [{ ...target, ...values() }], remove: [] }
      : { rules: [], remove: [target] }
  }
  const showError = (value: unknown, fallback: Parameters<typeof language.t>[0] = "opencodez.context.error") => {
    const cause = value instanceof Error ? value.cause : undefined
    const body = typeof cause === "object" && cause !== null && "body" in cause ? cause.body : value
    const conflict = typeof body === "object" && body !== null && "code" in body && body.code === "conflict"
    const small =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      body.message === "The context window must leave room for a model response"
    setState({
      error: t(conflict ? "opencodez.context.conflict" : small ? "opencodez.context.windowSmall" : fallback),
      conflict,
    })
  }
  const load = async () => {
    const request = ++loading
    setState("loading", true)
    try {
      const result = await source.client.opencodez.context.get()
      if (!disposed && request === loading && result.data) {
        const changed = state.data?.revision !== result.data.revision
        setState("data", result.data)
        if (changed && state.selected && state.pane === "editor" && !state.busy) {
          if (!dirty()) open(state.selected)
          else if (JSON.stringify(ruleValues(selectedRule())) === state.base) setState("revision", result.data.revision)
          else setState({ error: t("opencodez.context.conflict"), conflict: true })
        }
      }
    } catch (error) {
      if (!disposed && request === loading) showError(error)
    } finally {
      if (!disposed && request === loading) setState("loading", false)
    }
  }
  const guard = (action: () => void) => {
    if (state.busy) return
    if (!dirty()) return action()
    pending = action
    setState("confirm", true)
  }
  props.onNavigate?.(guard)
  createEffect(() => {
    if (!dialog.active) return
    const stop = dialog.guardClose((resume) => {
      if (state.busy) return false
      if (allowClose || !dirty()) return true
      guard(() => {
        allowClose = true
        resume()
      })
      return false
    })
    onCleanup(stop)
  })

  const targets = createMemo(() => {
    const models = state.data?.models ?? []
    const result = new Map<string, Target>()
    for (const model of models) {
      const target = state.scope === "model" ? model.id : model.family
      if (!target) continue
      const item = {
        scope: state.scope,
        providerID: model.providerID,
        target,
        name: state.scope === "model" ? model.name : model.family,
        providerName: model.providerName,
      }
      result.set(key(item), item)
    }
    for (const rule of state.data?.rules ?? []) {
      if (rule.scope !== state.scope || result.has(key(rule))) continue
      result.set(key(rule), { ...rule, name: rule.target, providerName: rule.providerID })
    }
    return [...result.values()].filter((item) =>
      `${item.name} ${item.target} ${item.providerName} ${item.providerID}`
        .toLowerCase()
        .includes(state.search.toLowerCase()),
    )
  })
  const groups = createMemo(() =>
    [...new Set(targets().map((item) => item.providerID))].map((id) => ({
      id,
      name: targets().find((item) => item.providerID === id)?.providerName,
      targets: targets().filter((item) => item.providerID === id),
    })),
  )
  const members = (catalog = state.data) =>
    catalog?.models.filter(
      (model) =>
        model.providerID === state.selected?.providerID &&
        (state.selected.scope === "model"
          ? model.id === state.selected.target
          : model.family === state.selected.target),
    ) ?? []
  const effective = () => members(state.resolved ?? state.data)[0]?.effective
  const range = (field: "contextWindow" | "tokenLimit" | "maxContextWindow") => {
    const values = members(state.resolved ?? state.data).map((model) => model.effective[field])
    if (!values.length) return "—"
    const low = Math.min(...values)
    const high = Math.max(...values)
    return low === high ? format(low) : `${format(low)}–${format(high)}`
  }
  const compactValue = () => {
    const models = members(state.resolved ?? state.data)
    if (models.every((model) => !model.effective.auto)) return t("opencodez.context.off")
    if (models.some((model) => !model.effective.auto)) return t("opencodez.context.varies")
    return range("tokenLimit")
  }
  const exceptions = () =>
    state.selected?.scope === "family" &&
    members().some((model) =>
      state.data?.rules.some(
        (rule) =>
          rule.scope === "model" &&
          rule.providerID === model.providerID &&
          (rule.target === model.id || rule.target === model.apiID),
      ),
    )
  const unusable = () =>
    values().contextWindow !== undefined && members(state.resolved).some((model) => model.effective.maxTokenLimit <= 0)
  const selectedRule = () => state.data?.rules.find((rule) => !!state.selected && key(rule) === key(state.selected))
  const open = (selected: Target) => {
    const rule = state.data?.rules.find((rule) => key(rule) === key(selected))
    const value = ruleValues(rule)
    setState({
      selected,
      window: rule?.contextWindow === undefined ? "" : format(rule.contextWindow),
      limit: rule?.tokenLimit === undefined ? "" : format(rule.tokenLimit),
      auto: rule?.auto,
      base: JSON.stringify(value),
      revision: state.data?.revision ?? "0",
      detail: true,
      pane: "editor",
      resolved: undefined,
      saved: false,
      error: undefined,
      conflict: false,
      confirm: false,
    })
  }
  createEffect(() => {
    if (!state.selected || state.pane !== "editor" || !state.data || invalid()) return
    const current = command()
    const revision = state.data.revision
    const request = ++resolving
    const timer = window.setTimeout(async () => {
      try {
        const result = await source.client.opencodez.context.resolve(current)
        if (!disposed && resolving === request && result.data && revision === state.data?.revision)
          setState("resolved", result.data)
      } catch (error) {
        if (!disposed && resolving === request) showError(error)
      }
    }, 180)
    onCleanup(() => {
      window.clearTimeout(timer)
      resolving++
    })
  })
  const save = async () => {
    if (!state.selected || state.busy || invalid() || unusable()) return false
    setState({ busy: true, error: undefined, conflict: false })
    try {
      const result = await source.client.opencodez.context.update({
        openCodezContextCommand: { revision: state.revision, ...command() },
      })
      if (!result.data || disposed) return false
      setState({
        data: result.data,
        resolved: undefined,
        base: JSON.stringify(values()),
        revision: result.data.revision,
        saved: true,
        confirm: false,
      })
      return true
    } catch (error) {
      showError(error)
      return false
    } finally {
      if (!disposed) setState("busy", false)
    }
  }
  const refresh = async () => {
    await load()
    if (state.data) setState({ revision: state.data.revision, conflict: false, error: undefined })
    if (state.pane === "import" && state.preview) {
      try {
        const previous = state.preview
        const result = await source.client.opencodez.context.preview({
          bundle: { format: "opencodez-context", version: 1, rules: previous.items.map((item) => ({ ...item.rule })) },
        })
        if (result.data)
          setState({
            preview: result.data,
            checked: result.data.items
              .filter(
                (item) =>
                  state.checked.includes(key(item.rule)) &&
                  item.status !== "same" &&
                  (item.status !== "changed" ||
                    previous.items.some((old) => key(old.rule) === key(item.rule) && old.status === "changed")),
              )
              .map((item) => key(item.rule)),
          })
      } catch (error) {
        showError(error)
      }
    }
  }
  const back = () =>
    guard(() => {
      if (state.pane !== "editor")
        setState({ pane: "editor", preview: undefined, checked: [], detail: !!state.selected })
      else if (state.detail) setState({ detail: false, selected: undefined, saved: false, error: undefined })
      else props.onSettingsBack()
    })
  const exportOpen = () =>
    guard(() =>
      setState({ pane: "export", detail: true, checked: (state.data?.rules ?? []).map(key), error: undefined }),
    )
  const importFile = async (incoming: File) => {
    setState({ preview: undefined, checked: [], saved: false })
    if (incoming.size > 1024 * 1024) {
      setState("error", t("opencodez.context.invalidFile"))
      if (file) file.value = ""
      return
    }
    setState({ busy: true, error: undefined, conflict: false })
    try {
      const bundle: unknown = JSON.parse(await incoming.text())
      const result = await source.client.opencodez.context.preview({ bundle })
      if (!result.data || disposed) return
      setState({
        preview: result.data,
        revision: result.data.revision,
        pane: "import",
        detail: true,
        checked: result.data.items.filter((item) => item.status === "new").map((item) => key(item.rule)),
      })
    } catch (error) {
      showError(error, "opencodez.context.invalidFile")
    } finally {
      if (!disposed) setState("busy", false)
      if (file) file.value = ""
    }
  }
  const importApply = async () => {
    if (!state.preview || !state.checked.length || state.busy) return
    setState({ busy: true, error: undefined, conflict: false })
    try {
      const result = await source.client.opencodez.context.update({
        openCodezContextCommand: {
          revision: state.preview.revision,
          rules: state.preview.items
            .filter((item) => state.checked.includes(key(item.rule)))
            .map((item) => ({ ...item.rule })),
        },
      })
      if (!result.data || disposed) return
      setState({
        data: result.data,
        pane: "editor",
        preview: undefined,
        selected: undefined,
        detail: false,
        saved: true,
        checked: [],
      })
    } catch (error) {
      showError(error)
    } finally {
      if (!disposed) setState("busy", false)
    }
  }
  const exportApply = async () => {
    if (state.busy || !state.checked.length) return
    setState({ busy: true, error: undefined })
    try {
      const result = await source.client.opencodez.context.export({
        targets: (state.data?.rules ?? [])
          .filter((rule) => state.checked.includes(key(rule)))
          .map((rule) => ({ scope: rule.scope, providerID: rule.providerID, target: rule.target })),
      })
      if (!result.data) throw new Error()
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.data, null, 2) + "\n"], { type: "application/json" }),
      )
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "opencodez-context.json"
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      showError(error)
    } finally {
      if (!disposed) setState("busy", false)
    }
  }
  const check = (target: OpenCodezContext.Target, checked: boolean) =>
    setState("checked", (current) =>
      checked ? [...new Set([...current, key(target)])] : current.filter((entry) => entry !== key(target)),
    )
  const name = (rule: OpenCodezContext.Target) =>
    state.data?.models.find(
      (model) =>
        model.providerID === rule.providerID &&
        (rule.scope === "model" ? model.id === rule.target : model.family === rule.target),
    )?.name ?? rule.target
  const summary = (value: OpenCodezContext.Values) =>
    `${format(value.contextWindow)} / ${value.auto === false ? t("opencodez.context.off") : format(value.tokenLimit)}`

  const resize = () => {
    if (disposed) return
    const element = frame ?? root?.closest("[data-component='dialog'], [data-component='dialog-v2']")
    if (!(element instanceof HTMLElement)) return
    frame = element
    element.setAttribute("data-oz-context", "")
    element.style.setProperty(
      "--oz-context-height",
      `${Math.round(window.visualViewport?.height ?? window.innerHeight)}px`,
    )
    element.style.setProperty("--oz-context-top", `${Math.round(window.visualViewport?.offsetTop ?? 0)}px`)
  }
  const scheduleResize = () => {
    if (disposed || viewportUpdate !== undefined) return
    viewportUpdate = requestAnimationFrame(() => {
      viewportUpdate = undefined
      resize()
    })
  }
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty()) {
      event.preventDefault()
      event.returnValue = ""
    }
  }
  onMount(() => {
    resize()
    void load()
    const stop = source.event.listen((event) => {
      if (event.details.type === "opencodez.context.changed" || event.details.type === "server.connected") void load()
    })
    const resume = () => {
      if (document.visibilityState === "visible") void load()
    }
    document.addEventListener("visibilitychange", resume)
    window.addEventListener("beforeunload", beforeUnload)
    window.visualViewport?.addEventListener("resize", scheduleResize)
    window.visualViewport?.addEventListener("scroll", scheduleResize)
    window.addEventListener("resize", scheduleResize)
    onCleanup(() => {
      disposed = true
      loading++
      resolving++
      stop()
      props.onNavigate?.(undefined)
      document.removeEventListener("visibilitychange", resume)
      window.removeEventListener("beforeunload", beforeUnload)
      window.visualViewport?.removeEventListener("resize", scheduleResize)
      window.visualViewport?.removeEventListener("scroll", scheduleResize)
      window.removeEventListener("resize", scheduleResize)
      if (viewportUpdate !== undefined) cancelAnimationFrame(viewportUpdate)
      frame?.removeAttribute("data-oz-context")
      frame?.style.removeProperty("--oz-context-height")
      frame?.style.removeProperty("--oz-context-top")
    })
  })

  return (
    <div
      class="oz-context"
      ref={root}
      data-component="opencodez-context-settings"
      data-detail={state.detail}
      data-pane={state.pane}
      onFocusIn={scheduleResize}
      onFocusOut={scheduleResize}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && state.pane === "editor") {
          event.preventDefault()
          event.stopPropagation()
          if (dirty()) void save()
        }
      }}
    >
      <input
        ref={file}
        type="file"
        hidden
        accept=".json,application/json"
        aria-label={t("opencodez.context.import")}
        onChange={(event) => {
          const incoming = event.currentTarget.files?.[0]
          if (incoming) void importFile(incoming)
        }}
      />
      <header class="oz-context-header">
        <Show when={state.pane === "editor"}>
          <button
            class="oz-context-tablet-back oz-context-icon"
            aria-label={t("sidebar.settings")}
            onClick={() => guard(props.onSettingsBack)}
          >
            <Icon name="arrow-left" />
          </button>
        </Show>
        <button
          class="oz-context-back oz-context-icon"
          aria-label={
            state.pane !== "editor"
              ? t("common.cancel")
              : state.detail
                ? t("opencodez.context.back")
                : t("sidebar.settings")
          }
          onClick={back}
        >
          <Icon name="arrow-left" />
        </button>
        <div class="oz-context-title">
          <h2>
            {t(
              state.pane === "import"
                ? "opencodez.context.review"
                : state.pane === "export"
                  ? "opencodez.context.export"
                  : "opencodez.context.title",
            )}
          </h2>
          <span>
            <Icon name="server" size="small" />
            <bdi>{source.server.displayName ?? source.url}</bdi>
          </span>
        </div>
        <Show when={state.pane === "editor"}>
          <button
            class="oz-context-icon"
            disabled={state.busy}
            aria-label={t("opencodez.context.import")}
            title={t("opencodez.context.import")}
            onClick={() => guard(() => file?.click())}
          >
            <Icon name="arrow-up" />
          </button>
          <button
            class="oz-context-icon"
            disabled={state.busy || !state.data?.rules.length}
            aria-label={t("opencodez.context.export")}
            title={t("opencodez.context.export")}
            onClick={exportOpen}
          >
            <Icon name="download" />
          </button>
        </Show>
      </header>
      <Show when={state.error || invalid() || (state.pane === "editor" && unusable())}>
        <div class="oz-context-error" role="alert">
          {state.error ?? invalid() ?? t("opencodez.context.windowSmall")}
          <Show when={state.conflict}>
            <button onClick={refresh} disabled={state.busy}>
              {t("opencodez.context.refresh")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={state.saved && !state.selected && state.pane === "editor"}>
        <div class="oz-context-status" role="status">
          {t("opencodez.context.saved")}
        </div>
      </Show>
      <div class="oz-context-body">
        <aside class="oz-context-list">
          <div class="oz-context-scope" role="group" aria-label={t("opencodez.context.select")}>
            <For each={["model", "family"] as const}>
              {(scope) => (
                <button
                  aria-pressed={state.scope === scope}
                  onClick={() => guard(() => setState({ scope, detail: false, selected: undefined, search: "" }))}
                >
                  {t(scope === "model" ? "opencodez.prompts.models" : "opencodez.prompts.families")}
                </button>
              )}
            </For>
          </div>
          <div class="oz-context-search">
            <Icon name="magnifying-glass" size="small" />
            <input
              type="search"
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
              placeholder={t("dialog.model.search.placeholder")}
              aria-label={t("dialog.model.search.placeholder")}
            />
          </div>
          <div class="oz-context-targets">
            <Show when={state.loading && !state.data}>
              <p class="oz-context-muted">{t("common.loading")}</p>
            </Show>
            <Show when={state.data && !targets().length}>
              <p class="oz-context-muted">{t("dialog.model.empty")}</p>
            </Show>
            <For each={groups()}>
              {(group) => (
                <section>
                  <h3>{group.name}</h3>
                  <For each={group.targets}>
                    {(target) => (
                      <button
                        class="oz-context-target"
                        data-selected={!!state.selected && key(target) === key(state.selected)}
                        onClick={() => guard(() => open(target))}
                      >
                        <span dir="auto">
                          {target.name}
                          <Show when={state.data?.rules.some((rule) => key(rule) === key(target))}>
                            <small>{t("opencodez.context.custom")}</small>
                          </Show>
                        </span>
                        <Icon name="chevron-right" size="small" />
                      </button>
                    )}
                  </For>
                </section>
              )}
            </For>
          </div>
        </aside>
        <main class="oz-context-detail">
          <Show when={state.pane === "editor"}>
            <Show
              when={state.selected}
              fallback={
                <div class="oz-context-empty">
                  <Icon name="sliders" />
                  <p>{t("opencodez.context.select")}</p>
                </div>
              }
            >
              {(target) => (
                <>
                  <div class="oz-context-scroll">
                    <div class="oz-context-model">
                      <h3 dir="auto">{target().name}</h3>
                      <span>
                        {target().providerName}
                        <Show when={target().scope === "family"}> · {members().length}</Show>
                      </span>
                      <Show when={exceptions()}>
                        <small>{t("opencodez.prompts.exceptions")}</small>
                      </Show>
                    </div>
                    <div class="oz-context-fields">
                      <label>
                        <span>
                          {t("opencodez.context.window")}
                          <small>{t("opencodez.context.tokens")}</small>
                        </span>
                        <input
                          type="text"
                          inputmode="numeric"
                          autocomplete="off"
                          dir="ltr"
                          value={state.window}
                          placeholder={`${t("opencodez.context.inherit")} · ${range("contextWindow")}`}
                          onInput={(event) => setState({ window: event.currentTarget.value, saved: false })}
                          onBlur={() => {
                            const value = number(state.window)
                            if (value !== undefined && !Number.isNaN(value)) setState("window", format(value))
                          }}
                          aria-invalid={!!invalid()}
                        />
                      </label>
                      <label>
                        <span>
                          {t("opencodez.context.threshold")}
                          <small>{t("opencodez.context.tokens")}</small>
                        </span>
                        <input
                          type="text"
                          inputmode="numeric"
                          autocomplete="off"
                          dir="ltr"
                          value={state.limit}
                          placeholder={`${t("opencodez.context.inherit")} · ${range("tokenLimit")}`}
                          onInput={(event) => setState({ limit: event.currentTarget.value, saved: false })}
                          onBlur={() => {
                            const value = number(state.limit)
                            if (value !== undefined && !Number.isNaN(value)) setState("limit", format(value))
                          }}
                          aria-invalid={!!invalid()}
                        />
                      </label>
                    </div>
                    <div class="oz-context-auto">
                      <Switch
                        checked={
                          state.auto ??
                          (target().scope === "family"
                            ? members(state.resolved ?? state.data)[0]?.inherited.auto
                            : effective()?.auto) ??
                          true
                        }
                        onChange={(auto) => setState({ auto, saved: false })}
                      >
                        <span>
                          {t("opencodez.context.auto")}
                          <small>
                            {state.auto === undefined
                              ? t("opencodez.context.inherit")
                              : t(state.auto ? "opencodez.context.on" : "opencodez.context.off")}
                          </small>
                        </span>
                      </Switch>
                    </div>
                    <Show
                      when={effective()}
                      fallback={<p class="oz-context-muted">{t("opencodez.context.unavailable")}</p>}
                    >
                      {(value) => (
                        <div class="oz-context-effective">
                          <h4>{t("opencodez.context.applied")}</h4>
                          <dl>
                            <div>
                              <dt>{t("opencodez.context.window")}</dt>
                              <dd dir="ltr">{range("contextWindow")}</dd>
                            </div>
                            <div>
                              <dt>{t("opencodez.context.threshold")}</dt>
                              <dd dir="auto">{compactValue()}</dd>
                            </div>
                          </dl>
                          <Show
                            when={
                              target().scope === "model" &&
                              ((number(state.window) ?? 0) > value().contextWindow ||
                                (number(state.limit) ?? 0) > value().tokenLimit)
                            }
                          >
                            <p>{t("opencodez.context.limited")}</p>
                          </Show>
                          <Show
                            when={value().maxContextWindow > 0 && range("contextWindow") !== range("maxContextWindow")}
                          >
                            <span>
                              {t("opencodez.context.maximum")} · <bdi dir="ltr">{range("maxContextWindow")}</bdi>
                            </span>
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show when={target().scope === "family" && members().length}>
                      <details class="oz-context-family">
                        <summary>
                          {t("opencodez.context.family")} · {members().length}
                        </summary>
                        <For each={members(state.resolved ?? state.data)}>
                          {(model) => (
                            <div>
                              <span dir="auto">
                                {model.name}
                                <Show
                                  when={state.data?.rules.some(
                                    (rule) =>
                                      rule.scope === "model" &&
                                      rule.providerID === model.providerID &&
                                      rule.target === model.id,
                                  )}
                                >
                                  <small>{t("opencodez.context.exception")}</small>
                                </Show>
                              </span>
                              <bdi>
                                {format(model.effective.contextWindow)} /{" "}
                                {model.effective.auto ? format(model.effective.tokenLimit) : t("opencodez.context.off")}
                              </bdi>
                            </div>
                          )}
                        </For>
                      </details>
                    </Show>
                  </div>
                  <footer class="oz-context-footer">
                    <button
                      class="oz-context-reset"
                      aria-label={t("opencodez.context.reset")}
                      title={t("opencodez.context.reset")}
                      disabled={state.busy || (!selectedRule() && !dirty())}
                      onClick={() =>
                        setState({ window: "", limit: "", auto: undefined, saved: false, error: undefined })
                      }
                    >
                      <Icon name="reset" size="small" />
                      {t("opencodez.context.resetShort")}
                    </button>
                    <span role="status">
                      {state.saved ? t("opencodez.context.saved") : dirty() ? t("opencodez.context.pending") : ""}
                    </span>
                    <button
                      class="oz-context-primary"
                      disabled={state.busy || !dirty() || !!invalid() || unusable()}
                      onClick={save}
                    >
                      {state.busy ? t("common.loading") : t("opencodez.prompts.save")}
                    </button>
                  </footer>
                </>
              )}
            </Show>
          </Show>
          <Show when={state.pane === "import" || state.pane === "export"}>
            <div class="oz-context-scroll">
              <div class="oz-context-selection">
                <span>{language.t("opencodez.context.selected", { count: state.checked.length })}</span>
                <button
                  onClick={() =>
                    setState(
                      "checked",
                      state.pane === "import"
                        ? (state.preview?.items ?? [])
                            .filter((item) => item.status !== "same")
                            .map((item) => key(item.rule))
                        : (state.data?.rules ?? []).map(key),
                    )
                  }
                >
                  {t("opencodez.context.all")}
                </button>
                <button onClick={() => setState("checked", [])}>{t("opencodez.context.none")}</button>
              </div>
              <Show when={state.pane === "import"}>
                <For each={state.preview?.items}>
                  {(item) => (
                    <label class="oz-context-transfer">
                      <input
                        type="checkbox"
                        checked={state.checked.includes(key(item.rule))}
                        disabled={item.status === "same"}
                        onChange={(event) => check(item.rule, event.currentTarget.checked)}
                      />
                      <span>
                        <strong dir="auto">{item.name}</strong>
                        <small>
                          {item.rule.providerID} ·{" "}
                          {t(
                            item.status === "new"
                              ? "opencodez.context.new"
                              : item.status === "same"
                                ? "opencodez.context.same"
                                : "opencodez.context.changed",
                          )}
                        </small>
                        <bdi>{summary(item.rule)}</bdi>
                        <Show when={item.current && item.status === "changed"}>
                          <small>
                            {t(
                              state.checked.includes(key(item.rule))
                                ? "opencodez.context.replace"
                                : "opencodez.context.keep",
                            )}{" "}
                            · <bdi>{summary(item.current ?? {})}</bdi>
                          </small>
                        </Show>
                        <Show when={!item.active}>
                          <small>{t("opencodez.context.unavailable")}</small>
                        </Show>
                      </span>
                    </label>
                  )}
                </For>
              </Show>
              <Show when={state.pane === "export"}>
                <Show when={!state.data?.rules.length}>
                  <p class="oz-context-muted">{t("opencodez.context.exportEmpty")}</p>
                </Show>
                <For each={state.data?.rules}>
                  {(rule) => (
                    <label class="oz-context-transfer">
                      <input
                        type="checkbox"
                        checked={state.checked.includes(key(rule))}
                        onChange={(event) => check(rule, event.currentTarget.checked)}
                      />
                      <span>
                        <strong dir="auto">{rule.scope === "family" ? rule.target : name(rule)}</strong>
                        <small>
                          {rule.providerID} ·{" "}
                          {t(rule.scope === "family" ? "opencodez.prompts.family" : "opencodez.prompts.model")}
                        </small>
                        <bdi>{summary(rule)}</bdi>
                      </span>
                    </label>
                  )}
                </For>
              </Show>
            </div>
            <footer class="oz-context-footer">
              <button onClick={back}>{t("common.cancel")}</button>
              <button
                class="oz-context-primary"
                disabled={state.busy || !state.checked.length}
                onClick={() => (state.pane === "import" ? importApply() : exportApply())}
              >
                {t(state.pane === "import" ? "opencodez.context.importApply" : "opencodez.context.exportApply")}
              </button>
            </footer>
          </Show>
        </main>
      </div>
      <Show when={state.confirm}>
        <div class="oz-context-confirm" role="alertdialog" aria-label={t("opencodez.context.pending")}>
          <p>{t("opencodez.context.pending")}</p>
          <div>
            <button
              onClick={() => {
                pending = undefined
                setState("confirm", false)
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => {
                const action = pending
                pending = undefined
                if (state.selected) open(state.selected)
                setState("confirm", false)
                action?.()
              }}
            >
              {t("opencodez.prompts.discard")}
            </button>
            <button
              class="oz-context-primary"
              disabled={state.busy || !!invalid() || unusable()}
              onClick={async () => {
                if (await save()) {
                  const action = pending
                  pending = undefined
                  action?.()
                }
              }}
            >
              {t("opencodez.prompts.save")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  )
}
