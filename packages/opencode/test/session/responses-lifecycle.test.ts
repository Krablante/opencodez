import { expect, test } from "bun:test"
import { createOpenAI } from "@ai-sdk/openai"
import { streamText } from "ai"
import { CodexResponsesAttempt } from "@/opencodez/codex-responses/attempt"
import { CodexResponsesContinuation } from "@/opencodez/codex-responses/continuation"
import { CodexResponsesCompact } from "@/opencodez/codex-responses/compact"
import { MessageV2 } from "@/session/message-v2"
import { ProviderV2 } from "@opencode-ai/core/provider"

for (const terminal of [
  { type: "response.completed", end_turn: false },
  { type: "response.incomplete", reason: "interrupted" },
  { type: "response.incomplete", reason: "max_output_tokens" },
  { type: "response.incomplete", reason: "content_filter" },
  { type: "response.incomplete", reason: "future_reason" },
  { type: "response.incomplete" },
  { type: "response.incomplete", reason: "max_output_tokens", noUsage: true },
]) {
  test(`Responses SDK preserves partial_answer and ${JSON.stringify(terminal)}`, async () => {
    const item = { id: "msg_partial", type: "message", role: "assistant", phase: "partial_answer", content: [] }
    const events = [
      { type: "response.created", response: { id: "resp_partial", created_at: 1, model: "test-model" } },
      { type: "response.output_item.added", output_index: 0, item },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "Partial answer",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...item, content: [{ type: "output_text", text: "Partial answer", annotations: [] }] },
      },
      {
        type: terminal.type,
        response: {
          id: "resp_partial",
          end_turn: terminal.end_turn,
          incomplete_details: terminal.reason ? { reason: terminal.reason } : null,
          usage: terminal.noUsage ? null : { input_tokens: 100, output_tokens: 5 },
        },
      },
    ]
    const sdk = createOpenAI({
      apiKey: "test-key",
      fetch: Object.assign(
        async () =>
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
        { preconnect: fetch.preconnect },
      ),
    })
    const result = streamText({ model: sdk.responses("test-model"), prompt: "Continue", maxRetries: 0 })
    const parts = await Array.fromAsync(result.fullStream)
    expect(parts.filter((part) => part.type === "error")).toEqual([])
    expect(await result.text).toBe("Partial answer")
    expect(parts.find((part) => part.type === "text-start")?.providerMetadata?.openai?.phase).toBe("partial_answer")
    const finish = parts.find((part) => part.type === "finish-step")
    expect(finish?.usage.inputTokens).toBe(terminal.noUsage ? undefined : 100)
    expect(finish?.usage.outputTokens).toBe(terminal.noUsage ? undefined : 5)
    const outcome = CodexResponsesAttempt.outcome(finish?.providerMetadata)
    const controlled = terminal.type === "response.completed" || terminal.reason === "interrupted"
    expect(outcome.continue).toBe(controlled)
    if (controlled) {
      expect(outcome.error).toBeUndefined()
      return
    }
    expect(outcome.error?.reason).toBe(terminal.reason ?? "unknown")
    const error = MessageV2.fromError(outcome.error, { providerID: ProviderV2.ID.make("openai") })
    expect(error).toMatchObject({
      name: "APIError",
      data: { isRetryable: false, metadata: { code: "response_incomplete" } },
    })
    expect(CodexResponsesCompact.canRetryWithCurrentModel(new Error("compact failed", { cause: outcome.error }))).toBe(
      false,
    )
  })
}

test("continuation accepts an empty delta and reports bounded rejection reasons", () => {
  const state = new CodexResponsesContinuation.Continuation()
  const reasons: CodexResponsesContinuation.RejectionReason[] = []
  const request = {
    model: "test-model",
    instructions: "private instructions",
    input: [{ role: "user", content: "private user text" }],
  }
  expect(state.prepare(request, (reason) => reasons.push(reason))).toBe(request)
  const output = {
    type: "message",
    role: "assistant",
    phase: "partial_answer",
    content: [{ type: "output_text", text: "partial" }],
  }
  const transaction = state.transaction(request)
  transaction.event({ type: "response.output_item.done", item: output })
  transaction.complete({ type: "response.completed", response: { id: "resp_test" } })
  const next = { ...request, input: [...request.input, output] }
  expect(state.prepare(next)).toEqual({ ...next, input: [], previous_response_id: "resp_test" })
  state.prepare({ ...next, model: "changed" }, (reason) => reasons.push(reason))
  state.prepare({ ...next, input: request.input }, (reason) => reasons.push(reason))
  state.prepare({ ...next, input: [{ role: "user", content: "changed" }, output] }, (reason) => reasons.push(reason))
  expect(reasons).toEqual(["missing_previous_response", "model_changed", "input_shortened", "history_mismatch"])
  expect(JSON.stringify(reasons)).not.toContain("private")
})
