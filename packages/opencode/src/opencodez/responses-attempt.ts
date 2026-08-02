import type { PartID } from "@/session/schema"
import { OpenCodezResponsesPolicy } from "./responses-policy"

export type Rollback = {
  readonly partIDs: readonly PartID[]
  readonly durableOutput: boolean
  readonly modelVisible: boolean
}

export function create() {
  let enabled = false
  let irreversible = false
  let modelVisible = false
  let durableOutput = false
  const partIDs = new Set<PartID>()

  function begin(input: { durableOutput: boolean }) {
    irreversible = false
    modelVisible = false
    durableOutput = input.durableOutput
    partIDs.clear()
  }

  function prepared(input: { codexResponses: boolean }) {
    enabled = input.codexResponses
  }

  function track(partID: PartID) {
    if (!enabled) return
    partIDs.add(partID)
  }

  function markModelVisible() {
    if (!enabled) return
    modelVisible = true
  }

  function markIrreversible() {
    if (!enabled) return
    irreversible = true
  }

  function canRetry(input: { durableOutput: boolean }) {
    return enabled ? !irreversible : !input.durableOutput
  }

  function retryLimit() {
    return enabled ? OpenCodezResponsesPolicy.requestRetryLimit("sampling") : undefined
  }

  function rollback(): Rollback | undefined {
    if (!enabled || irreversible) return undefined
    const result = {
      partIDs: [...partIDs].reverse(),
      durableOutput,
      modelVisible,
    } satisfies Rollback
    partIDs.clear()
    modelVisible = false
    return result
  }

  function commit() {
    partIDs.clear()
    modelVisible = false
  }

  return {
    begin,
    prepared,
    track,
    markModelVisible,
    markIrreversible,
    canRetry,
    retryLimit,
    rollback,
    commit,
  }
}

export * as OpenCodezResponsesAttempt from "./responses-attempt"
