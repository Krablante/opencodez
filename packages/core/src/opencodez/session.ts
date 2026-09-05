export * as OpenCodezSession from "./session"

import { OpenCodezSettings } from "./settings"

export type Selection = {
  system?: string | null
  systemManual?: boolean
}

export type PersistedState = {
  selection?: Selection
}

const metadataKey = "opencodez"
const selectionLimit = 256
const selections = new Map<string, Selection>()
const listeners = new Set<() => void>()
let pendingSelection: Selection = {}
let versionID = 0

export const noneID = "none"

export function isNone(name: string) {
  return name.trim().toLowerCase() === noneID
}

export function disable(): Selection {
  return { system: null, systemManual: true }
}

export function version() {
  return versionID
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function pending() {
  return pendingSelection
}

export function consumePending(sessionID: string) {
  if (Object.keys(pendingSelection).length === 0) return
  cacheSelection(sessionID, { ...pendingSelection })
  pendingSelection = {}
  notify()
}

export function apply(sessionID: string | undefined, selection: Selection, metadata?: Record<string, unknown>) {
  if (!sessionID) {
    pendingSelection = merge(pendingSelection, selection)
    notify()
    return
  }
  cacheSelection(sessionID, merge(selectionForSession(sessionID, metadata), selection))
  notify()
}

export function resetPending(selection: Selection = {}) {
  pendingSelection = selection
  notify()
}

export function effective(input: {
  config?: OpenCodezSettings.ConfigLike
  model?: OpenCodezSettings.ModelLike
  modelID?: string
  sessionID?: string
  metadata?: Record<string, unknown>
}) {
  const model = input.model ?? input.modelID
  const state = input.sessionID ? selectionForSession(input.sessionID, input.metadata) : pendingSelection
  return effectiveForSelection(input.config, model, state)
}

export function indicator(input: {
  config?: OpenCodezSettings.ConfigLike
  model?: OpenCodezSettings.ModelLike
  modelID?: string
  sessionID?: string
  metadata?: Record<string, unknown>
}) {
  const result = effective(input)
  return {
    ...result,
    system: result.system ?? (result.systemManual ? noneID : upstreamSystemPromptID(input.model ?? input.modelID)),
  }
}

export function indicatorFromMetadata(input: {
  config?: OpenCodezSettings.ConfigLike
  model?: OpenCodezSettings.ModelLike
  modelID?: string
  metadata?: Record<string, unknown>
}) {
  const result = effectiveForSelection(
    input.config,
    input.model ?? input.modelID,
    fromMetadata(input.metadata).selection ?? {},
  )
  return {
    ...result,
    system: result.system ?? (result.systemManual ? noneID : upstreamSystemPromptID(input.model ?? input.modelID)),
  }
}

export function hydrate(sessionID: string | undefined, metadata?: Record<string, unknown>) {
  if (!sessionID) return
  const selection = fromMetadata(metadata).selection
  if (!selection) {
    if (selections.delete(sessionID)) notify()
    return
  }
  if (sameSelection(selections.get(sessionID), selection)) {
    cacheSelection(sessionID, selection)
    return
  }
  cacheSelection(sessionID, selection)
  notify()
}

export function clear(sessionID: string) {
  if (selections.delete(sessionID)) notify()
}

export function pendingMetadata() {
  return withState(undefined, {
    selection: cleanSelection(pendingSelection),
  })
}

export function metadataWithSessionState(metadata: Record<string, unknown> | undefined, sessionID: string | undefined) {
  if (!sessionID) return metadata ?? {}
  return withState(metadata, {
    selection: cleanSelection(selections.get(sessionID) ?? fromMetadata(metadata).selection ?? {}),
  })
}

export function metadataWithSelection(metadata: Record<string, unknown> | undefined, selection: Selection) {
  const state = fromMetadata(metadata)
  return withState(metadata, {
    ...state,
    selection: cleanSelection(merge(state.selection ?? {}, selection)),
  })
}

export function fromMetadata(metadata?: Record<string, unknown>): PersistedState {
  const raw = metadata?.[metadataKey]
  if (!isRecord(raw)) return {}
  return {
    selection: cleanSelection(isRecord(raw.selection) ? readSelection(raw.selection) : {}),
  }
}

export function withState(metadata: Record<string, unknown> | undefined, state: PersistedState) {
  const next = { ...metadata }
  const selection = cleanSelection(state.selection ?? {})
  const opencodez = {
    version: 1,
    ...(selection ? { selection } : {}),
  }
  if (!selection) delete next[metadataKey]
  else next[metadataKey] = opencodez
  return next
}

function merge(current: Selection, next: Selection): Selection {
  return {
    system: next.system !== undefined ? next.system : current.system,
    systemManual: next.systemManual ?? current.systemManual,
  }
}

function effectiveForSelection(
  config: OpenCodezSettings.ConfigLike | undefined,
  model: OpenCodezSettings.ModelLike | undefined,
  state: Selection,
) {
  const defaultSystem = OpenCodezSettings.defaultSystem(config, model)
  return {
    system: state.systemManual ? (state.system ?? undefined) : defaultSystem,
    systemManual: state.systemManual === true,
  }
}

function selectionForSession(sessionID: string, metadata?: Record<string, unknown>) {
  if (metadata !== undefined) return fromMetadata(metadata).selection ?? {}
  const selection = selections.get(sessionID)
  if (!selection) return {}
  cacheSelection(sessionID, selection)
  return selection
}

function cacheSelection(sessionID: string, selection: Selection) {
  selections.delete(sessionID)
  selections.set(sessionID, selection)
  while (selections.size > selectionLimit) {
    const oldest = selections.keys().next().value
    if (oldest === undefined) return
    selections.delete(oldest)
  }
}

function upstreamSystemPromptID(model: OpenCodezSettings.ModelLike | undefined) {
  const id =
    typeof model === "string" ? (model.includes("/") ? model.split("/").at(-1) : model) : (model?.api?.id ?? model?.id)
  if (!id) return "default"
  return providerNameFromID(id)
}

function providerNameFromID(modelID: string) {
  if (modelID.includes("gpt-4") || modelID.includes("o1") || modelID.includes("o3")) return "beast"
  if (modelID.includes("gpt")) {
    if (modelID.includes("codex")) return "codex"
    return "gpt"
  }
  if (modelID.includes("gemini-")) return "gemini"
  if (modelID.includes("claude")) return "anthropic"
  if (modelID.toLowerCase().includes("trinity")) return "trinity"
  if (modelID.toLowerCase().includes("kimi")) return "kimi"
  return "default"
}

function readSelection(input: Record<string, unknown>): Selection {
  return {
    system: typeof input.system === "string" || input.system === null ? input.system : undefined,
    systemManual: typeof input.systemManual === "boolean" ? input.systemManual : undefined,
  }
}

function cleanSelection(input: Selection): Selection | undefined {
  const systemManual = input.systemManual === true
  const selection = {
    system: systemManual ? (input.system ?? null) : undefined,
    systemManual: systemManual ? true : undefined,
  }
  return Object.values(selection).some((value) => value !== undefined) ? selection : undefined
}

function sameSelection(left: Selection | undefined, right: Selection | undefined) {
  return JSON.stringify(cleanSelection(left ?? {})) === JSON.stringify(cleanSelection(right ?? {}))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function notify() {
  versionID++
  for (const listener of listeners) listener()
}
