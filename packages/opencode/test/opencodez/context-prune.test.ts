import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { OpenCodezContextPrune } from "../../src/session/llm/context-prune"

const settings = {
  enabled: true,
  pruning_size: 10,
  preserve_tools: [] as string[],
  prune: {
    reasoning: true,
    tool: true,
  },
}

describe("OpenCodezContextPrune", () => {
  test("keeps newest eligible payloads within the shared budget", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-result", toolCallId: "old", toolName: "shell", output: { type: "text", value: "old output" } },
          { type: "tool-result", toolCallId: "new", toolName: "shell", output: { type: "text", value: "new" } },
        ],
      },
    ] as unknown as ModelMessage[]

    const result = OpenCodezContextPrune.apply({ messages, settings: { ...settings, pruning_size: 3 } }) as any[]

    expect(result[0].content[0].output.value).toBe("[Tool output pruned: 10 chars]")
    expect(result[0].content[1].output.value).toBe("new")
    expect((messages as any[])[0].content[0].output.value).toBe("old output")
  })

  test("pruning_size zero replaces all eligible payloads but not tool calls or preserved tools", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool-call", toolCallId: "call", toolName: "read", input: { file: "a.ts" } },
          { type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "preserved" } },
          { type: "tool-result", toolCallId: "call-2", toolName: "shell", output: { type: "text", value: "removed" } },
        ],
      },
    ] as unknown as ModelMessage[]

    const result = OpenCodezContextPrune.apply({
      messages,
      settings: { ...settings, pruning_size: 0, preserve_tools: ["read"] },
    }) as any[]

    expect(result[0].content[0].text).toBe("[reasoning pruned: 8 chars]")
    expect(result[0].content[1]).toEqual((messages as any[])[0].content[1])
    expect(result[0].content[2].output.value).toBe("preserved")
    expect(result[0].content[3].output.value).toBe("[Tool output pruned: 7 chars]")
  })

  test("preserve_tools payloads do not count toward budget", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "read",
            toolName: "read",
            output: { type: "text", value: "huge preserved output" },
          },
          { type: "tool-result", toolCallId: "shell", toolName: "shell", output: { type: "text", value: "ok" } },
        ],
      },
    ] as unknown as ModelMessage[]

    const result = OpenCodezContextPrune.apply({
      messages,
      settings: { ...settings, pruning_size: 2, preserve_tools: ["read"] },
    }) as any[]

    expect(result[0].content[0].output.value).toBe("huge preserved output")
    expect(result[0].content[1].output.value).toBe("ok")
  })

  test("disabled pruning returns the original messages", () => {
    const messages = [
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
    ] as unknown as ModelMessage[]
    expect(OpenCodezContextPrune.apply({ messages, settings: { ...settings, enabled: false } })).toBe(messages)
  })
})
