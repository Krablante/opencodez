export * as OpenCodezSession from "./session"

import { OpenCodezSettings } from "./settings"
import { SystemPrompt } from "@/session/system"

export type Selection = {
  system?: string
  tone?: string
  systemManual?: boolean
  toneManual?: boolean
}

export type PruningOverride = {
  enabled?: boolean
  pruning_size?: number
}

export type PersistedState = {
  selection?: Selection
  pruning?: PruningOverride
}

const metadataKey = "opencodez"
const selections = new Map<string, Selection>()
const pruningOverrides = new Map<string, PruningOverride>()
const listeners = new Set<() => void>()
let pendingSelection: Selection = {}
let pendingPruning: PruningOverride = {}
let versionID = 0

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
  if (Object.keys(pendingSelection).length === 0 && Object.keys(pendingPruning).length === 0) return
  if (Object.keys(pendingSelection).length > 0) selections.set(sessionID, { ...pendingSelection })
  if (Object.keys(pendingPruning).length > 0) pruningOverrides.set(sessionID, { ...pendingPruning })
  pendingSelection = {}
  pendingPruning = {}
  notify()
}

export function apply(sessionID: string | undefined, selection: Selection, metadata?: Record<string, unknown>) {
  if (!sessionID) {
    pendingSelection = merge(pendingSelection, selection)
    notify()
    return
  }
  selections.set(sessionID, merge(selectionForSession(sessionID, metadata), selection))
  notify()
}

export function resetPending(selection: Selection = {}, pruning: PruningOverride = {}) {
  pendingSelection = selection
  pendingPruning = pruning
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
    system: result.system ?? upstreamSystemPromptID(input.model ?? input.modelID),
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
    system: result.system ?? upstreamSystemPromptID(input.model ?? input.modelID),
  }
}

export function setPruning(sessionID: string | undefined, next: PruningOverride, metadata?: Record<string, unknown>) {
  if (!sessionID) {
    pendingPruning = mergePruning(pendingPruning, next)
    notify()
    return
  }
  pruningOverrides.set(sessionID, mergePruning(pruningForSession(sessionID, metadata), next))
  notify()
}

export function effectivePruning(input: {
  config?: OpenCodezSettings.ConfigLike
  sessionID?: string
  metadata?: Record<string, unknown>
}) {
  const base = OpenCodezSettings.pruning(input.config)
  const override = input.sessionID ? pruningForSession(input.sessionID, input.metadata) : pendingPruning
  return {
    ...base,
    enabled: override?.enabled ?? base.enabled,
    pruning_size: override?.pruning_size ?? base.pruning_size,
  }
}

export function hydrate(sessionID: string | undefined, metadata?: Record<string, unknown>) {
  if (!sessionID) return
  const state = fromMetadata(metadata)
  let changed = false
  if (state.selection && !sameSelection(selections.get(sessionID), state.selection)) {
    selections.set(sessionID, state.selection)
    changed = true
  }
  if (state.pruning && !samePruning(pruningOverrides.get(sessionID), state.pruning)) {
    pruningOverrides.set(sessionID, state.pruning)
    changed = true
  }
  if (changed) notify()
}

export function pendingMetadata() {
  return withState(undefined, {
    selection: cleanSelection(pendingSelection),
    pruning: cleanPruning(pendingPruning),
  })
}

export function metadataWithSessionState(metadata: Record<string, unknown> | undefined, sessionID: string | undefined) {
  if (!sessionID) return metadata ?? {}
  return withState(metadata, {
    selection: cleanSelection(selectionForSession(sessionID, metadata)),
    pruning: cleanPruning(pruningForSession(sessionID, metadata)),
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
    pruning: cleanPruning(isRecord(raw.pruning) ? readPruning(raw.pruning) : {}),
  }
}

export function withState(metadata: Record<string, unknown> | undefined, state: PersistedState) {
  const next = { ...(metadata ?? {}) }
  const selection = cleanSelection(state.selection ?? {})
  const pruning = cleanPruning(state.pruning ?? {})
  const opencodez = {
    version: 1,
    ...(selection ? { selection } : {}),
    ...(pruning ? { pruning } : {}),
  }
  if (!selection && !pruning) delete next[metadataKey]
  else next[metadataKey] = opencodez
  return next
}

function merge(current: Selection, next: Selection): Selection {
  return {
    system: next.system ?? current.system,
    tone: next.tone ?? current.tone,
    systemManual: next.systemManual ?? current.systemManual,
    toneManual: next.toneManual ?? current.toneManual,
  }
}

function effectiveForSelection(
  config: OpenCodezSettings.ConfigLike | undefined,
  model: OpenCodezSettings.ModelLike | undefined,
  state: Selection,
) {
  const defaults = {
    system: OpenCodezSettings.defaultSystem(config, model),
    tone: OpenCodezSettings.defaultTone(config, model),
  }
  return {
    system: state.systemManual && state.system ? state.system : defaults.system,
    tone: state.toneManual && state.tone ? state.tone : defaults.tone,
    systemManual: state.systemManual === true,
    toneManual: state.toneManual === true,
  }
}

function selectionForSession(sessionID: string, metadata?: Record<string, unknown>) {
  return selections.get(sessionID) ?? fromMetadata(metadata).selection ?? {}
}

function pruningForSession(sessionID: string, metadata?: Record<string, unknown>) {
  return pruningOverrides.get(sessionID) ?? fromMetadata(metadata).pruning ?? {}
}

function upstreamSystemPromptID(model: OpenCodezSettings.ModelLike | undefined) {
  const id =
    typeof model === "string"
      ? (model.includes("/") ? model.split("/").at(-1) : model)
      : (model?.api?.id ?? model?.id)
  if (!id) return "default"
  return SystemPrompt.providerNameFromID(id)
}

function mergePruning(current: PruningOverride, next: PruningOverride): PruningOverride {
  return {
    enabled: next.enabled ?? current.enabled,
    pruning_size: next.pruning_size ?? current.pruning_size,
  }
}

function readSelection(input: Record<string, unknown>): Selection {
  return {
    system: typeof input.system === "string" ? input.system : undefined,
    tone: typeof input.tone === "string" ? input.tone : undefined,
    systemManual: typeof input.systemManual === "boolean" ? input.systemManual : undefined,
    toneManual: typeof input.toneManual === "boolean" ? input.toneManual : undefined,
  }
}

function readPruning(input: Record<string, unknown>): PruningOverride {
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    pruning_size:
      typeof input.pruning_size === "number" && Number.isInteger(input.pruning_size) && input.pruning_size >= 0
        ? input.pruning_size
        : undefined,
  }
}

function cleanSelection(input: Selection): Selection | undefined {
  const selection = {
    system: input.systemManual && input.system ? input.system : undefined,
    tone: input.toneManual && input.tone ? input.tone : undefined,
    systemManual: input.systemManual && input.system ? true : undefined,
    toneManual: input.toneManual && input.tone ? true : undefined,
  }
  return Object.values(selection).some((value) => value !== undefined) ? selection : undefined
}

function cleanPruning(input: PruningOverride): PruningOverride | undefined {
  const pruning = {
    enabled: input.enabled,
    pruning_size: input.pruning_size,
  }
  return Object.values(pruning).some((value) => value !== undefined) ? pruning : undefined
}

function sameSelection(left: Selection | undefined, right: Selection | undefined) {
  return JSON.stringify(cleanSelection(left ?? {})) === JSON.stringify(cleanSelection(right ?? {}))
}

function samePruning(left: PruningOverride | undefined, right: PruningOverride | undefined) {
  return JSON.stringify(cleanPruning(left ?? {})) === JSON.stringify(cleanPruning(right ?? {}))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function notify() {
  versionID++
  for (const listener of listeners) listener()
}
