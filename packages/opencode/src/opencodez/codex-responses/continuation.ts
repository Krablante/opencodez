import { isRecord } from "@/util/record"

type CompletedResponse = {
  request: Record<string, unknown>
  responseID: string
  outputItems: unknown[]
}

export type RejectionReason =
  | "missing_previous_response"
  | "missing_response_id"
  | "invalid_input"
  | "model_changed"
  | "tools_changed"
  | "instructions_changed"
  | "reasoning_changed"
  | "settings_changed"
  | "input_shortened"
  | "history_mismatch"

export * as CodexResponsesContinuation from "./continuation"

export class Continuation {
  private previous?: CompletedResponse
  private generation = 0
  private unavailable: RejectionReason = "missing_previous_response"

  prepare(request: Record<string, unknown>, rejected?: (reason: RejectionReason) => void): Record<string, unknown> {
    const full = (reason: RejectionReason) => {
      rejected?.(reason)
      return request
    }
    const input = request.input
    if (!this.previous) return full(this.unavailable)
    if (!Array.isArray(input)) return full("invalid_input")

    const previousInput = this.previous.request.input
    if (!Array.isArray(previousInput)) return full("invalid_input")
    if (!propertiesMatch(this.previous.request, request)) {
      for (const key of ["model", "tools", "instructions", "reasoning"] as const) {
        if (!jsonEqual(this.previous.request[key], request[key])) return full(`${key}_changed`)
      }
      return full("settings_changed")
    }

    const prefixLength = previousInput.length + this.previous.outputItems.length
    if (input.length < prefixLength) return full("input_shortened")
    for (let index = 0; index < prefixLength; index++) {
      const previous =
        index < previousInput.length ? previousInput[index] : this.previous.outputItems[index - previousInput.length]
      if (!responseItemsEqual(input[index], previous)) return full("history_mismatch")
    }

    const delta = input.slice(prefixLength)
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
          this.unavailable = "missing_response_id"
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
        this.unavailable = "missing_previous_response"
      },
    }
  }

  reset() {
    this.generation++
    this.previous = undefined
    this.unavailable = "missing_previous_response"
  }
}

function propertiesMatch(previous: Record<string, unknown>, next: Record<string, unknown>) {
  return jsonEqual(requestProperties(previous), requestProperties(next))
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

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonEqual(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!(key in right) || !jsonEqual(left[key], right[key])) return false
  }
  return true
}
