import { isRecord } from "@/util/record"

export type Mode = "legacy" | "codex"

type CompletedResponse = {
  request: Record<string, unknown>
  responseID: string
  outputItems: unknown[]
}

export class Continuation {
  private previous?: CompletedResponse
  private generation = 0

  prepare(request: Record<string, unknown>): Record<string, unknown> {
    const input = request.input
    if (!this.previous || !Array.isArray(input)) return request

    const previousInput = this.previous.request.input
    if (!Array.isArray(previousInput) || !propertiesMatch(this.previous.request, request)) return request

    const prefix = [...previousInput, ...this.previous.outputItems]
    if (input.length <= prefix.length) return request
    for (let index = 0; index < prefix.length; index++) {
      if (!responseItemsEqual(input[index], prefix[index])) return request
    }

    const delta = input.slice(prefix.length)
    return {
      ...request,
      input: delta,
      previous_response_id: this.previous.responseID,
    }
  }

  transaction(request: Record<string, unknown>) {
    const outputItems: unknown[] = []
    const generation = this.generation
    let done = false

    return {
      event: (event: Record<string, unknown>) => {
        if (done) return
        if (event.type === "response.output_item.done" && "item" in event) outputItems.push(event.item)
      },
      complete: (event: Record<string, unknown>) => {
        if (done) return
        done = true
        if (generation !== this.generation) return
        const response = isRecord(event.response) ? event.response : undefined
        const responseID = typeof response?.id === "string" ? response.id : undefined
        if (!responseID) {
          this.previous = undefined
          return
        }
        const items = outputItems.length > 0 ? outputItems : Array.isArray(response?.output) ? response.output : []
        this.previous = { request, responseID, outputItems: items }
      },
      fail: () => {
        if (done) return
        done = true
        if (generation !== this.generation) return
        this.previous = undefined
      },
    }
  }

  reset() {
    this.generation++
    this.previous = undefined
  }
}

function propertiesMatch(previous: Record<string, unknown>, next: Record<string, unknown>) {
  return jsonEqual(requestProperties(previous), requestProperties(next), false)
}

function responseItemsEqual(left: unknown, right: unknown) {
  return responseItemValueEqual(left, right, true)
}

function responseItemValueEqual(left: unknown, right: unknown, top: boolean): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => responseItemValueEqual(value, right[index], false))
  }
  if (!isRecord(left) || !isRecord(right)) return false

  const leftKeys = responseItemKeys(left, top)
  const rightKeys = responseItemKeys(right, top)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!(key in right) || !responseItemValueEqual(left[key], right[key], false)) return false
  }
  return true
}

function responseItemKeys(value: Record<string, unknown>, top: boolean) {
  return Object.keys(value).filter((key) => {
    if (key === "_meta") return false
    if (top && (key === "id" || key === "status")) return false
    if (top && key === "type" && value.type === "message" && value.role === "assistant") return false
    if (
      top &&
      key === "content" &&
      value.type === "reasoning" &&
      Array.isArray(value.content) &&
      value.content.length === 0
    )
      return false
    if ((key === "annotations" || key === "logprobs") && Array.isArray(value[key]) && value[key].length === 0)
      return false
    return true
  })
}

function requestProperties(request: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(request)) {
    if (key === "input" || key === "previous_response_id" || key === "client_metadata") continue
    result[key] = value
  }
  return result
}

function jsonEqual(left: unknown, right: unknown, ignoreInternalMetadata: boolean): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index], ignoreInternalMetadata))
  }
  if (!isRecord(left) || !isRecord(right)) return false

  const leftKeys = Object.keys(left).filter((key) => !ignoreInternalMetadata || key !== "_meta")
  const rightKeys = Object.keys(right).filter((key) => !ignoreInternalMetadata || key !== "_meta")
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!(key in right) || !jsonEqual(left[key], right[key], ignoreInternalMetadata)) return false
  }
  return true
}
