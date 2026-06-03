import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"

let tmp = ""
let LLMRequestPrep: typeof import("../../src/session/llm/request").LLMRequestPrep

const modalities = {
  text: true,
  audio: false,
  image: false,
  video: false,
  pdf: false,
}

const model = {
  id: "gpt-5.5",
  providerID: "openai",
  api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5.5",
  family: undefined,
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: modalities,
    output: modalities,
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 4096 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
} as any

const provider = {
  id: "openai",
  name: "OpenAI",
  source: "custom",
  env: [],
  options: {},
  models: { [model.id]: model },
} as any

const baseInput = {
  user: {
    id: "msg-user",
    system: undefined,
    tools: {},
    model: {},
  },
  sessionID: "session-1",
  model,
  agent: {
    name: "build",
    mode: "primary",
    permission: [],
    options: {},
    prompt: "AGENT PROMPT",
  },
  permission: [],
  system: ["EXTRA SYSTEM"],
  messages: [],
  tools: {},
  provider,
  auth: undefined,
  plugin: {
    trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
  },
  flags: {
    outputTokenMax: undefined,
    client: "cli",
  },
  isWorkflow: false,
  config: {
    opencodez: {
      pruning: {
        enabled: true,
        pruning_size: 20_000,
        preserve_tools: [],
        prune: { reasoning: true, tool: true },
      },
    },
  },
} as any

describe("LLMRequestPrep OpenCodez integration", () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-request-prep-"))
    process.env.OPENCODE_APP_NAME = "opencodez"
    process.env.OPENCODE_CLI_NAME = "opencodez"
    process.env.OPENCODEZ = "1"
    process.env.XDG_CONFIG_HOME = path.join(tmp, "config")
    process.env.XDG_DATA_HOME = path.join(tmp, "data")
    process.env.XDG_CACHE_HOME = path.join(tmp, "cache")
    process.env.XDG_STATE_HOME = path.join(tmp, "state")
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config", "opencodez")

    const root = path.join(tmp, "config", "opencodez", "prompts")
    await fs.mkdir(path.join(root, "core"), { recursive: true })
    await fs.mkdir(path.join(root, "tone"), { recursive: true })
    await fs.writeFile(path.join(root, "core", "codex_gpt_5_5.md"), "CORE PROMPT")
    await fs.writeFile(path.join(root, "tone", "codex_pragmatic.md"), "TONE PROMPT")
    await fs.writeFile(path.join(root, "core", "manual_core.md"), "MANUAL SYSTEM PROMPT")
    await fs.writeFile(path.join(root, "tone", "manual_tone.md"), "MANUAL TONE PROMPT")

    LLMRequestPrep = (await import("../../src/session/llm/request")).LLMRequestPrep
  })

  afterAll(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  test("uses Codex Core and Tone defaults for OpenAI Responses GPT", async () => {
    const prepared = await Effect.runPromise(LLMRequestPrep.prepare(baseInput))
    const system = prepared.system.join("\n")

    expect(system).toContain("CORE PROMPT")
    expect(system).toContain("AGENT PROMPT")
    expect(system).toContain("TONE PROMPT")
    expect(system).toContain("EXTRA SYSTEM")
    expect(prepared.messages[0]).toEqual({
      role: "system",
      content: prepared.system[0],
    })
  })

  test("detects production-shaped OpenAI Responses GPT models", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        model: {
          ...model,
          api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
        },
      }),
    )
    const system = prepared.system.join("\n")

    expect(system).toContain("CORE PROMPT")
    expect(system).toContain("TONE PROMPT")
  })

  test("uses OpenAI API model id when the catalog model id is an alias", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        model: {
          ...model,
          id: "alias-gpt55",
          api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
        },
      }),
    )
    const system = prepared.system.join("\n")

    expect(system).toContain("CORE PROMPT")
    expect(system).toContain("TONE PROMPT")
  })

  test("matches config defaults by OpenAI API model id when the catalog model id is an alias", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        config: {
          opencodez: {
            responses: {
              system: { "gpt-5.5": "manual_core" },
              tone: { "gpt-5.5": "manual_tone" },
            },
            pruning: {
              enabled: true,
              pruning_size: 20_000,
              preserve_tools: [],
              prune: { reasoning: true, tool: true },
            },
          },
        },
        model: {
          ...model,
          id: "alias-gpt55",
          api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
        },
      }),
    )
    const system = prepared.system.join("\n")

    expect(system).toContain("MANUAL SYSTEM PROMPT")
    expect(system).toContain("MANUAL TONE PROMPT")
    expect(system).not.toContain("CORE PROMPT")
  })

  test("keeps upstream request system for non-Responses models without OpenCodez defaults", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        model: {
          ...model,
          id: "deepseek-chat",
          providerID: "deepseek",
          api: { id: "deepseek-chat", url: "https://api.deepseek.com", npm: "@ai-sdk/deepseek" },
          name: "DeepSeek Chat",
        },
        provider: {
          ...provider,
          id: "deepseek",
          models: {},
        },
      }),
    )
    const system = prepared.system.join("\n")

    expect(system).toContain("AGENT PROMPT")
    expect(system).toContain("EXTRA SYSTEM")
    expect(system).not.toContain("CORE PROMPT")
    expect(system).not.toContain("TONE PROMPT")
  })

  test("applies user config defaults to non-Responses model families", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        config: {
          opencodez: {
            responses: {
              system: { deepseek: "manual_core" },
              tone: { deepseek: "manual_tone" },
            },
            pruning: {
              enabled: true,
              pruning_size: 20_000,
              preserve_tools: [],
              prune: { reasoning: true, tool: true },
            },
          },
        },
        model: {
          ...model,
          id: "deepseek-chat",
          providerID: "deepseek",
          family: "deepseek",
          api: { id: "deepseek-chat", url: "https://api.deepseek.com", npm: "@ai-sdk/deepseek" },
          name: "DeepSeek Chat",
        },
        provider: {
          ...provider,
          id: "deepseek",
          models: {},
        },
      }),
    )
    const system = prepared.system.join("\n")

    expect(system).toContain("MANUAL SYSTEM PROMPT")
    expect(system).toContain("MANUAL TONE PROMPT")
    expect(system).toContain("AGENT PROMPT")
    expect(system).not.toContain("CORE PROMPT")
  })

  test("applies pruning to prepared messages", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        config: {
          opencodez: {
            responses: {
              system: "codex_gpt_5_5",
              tone: "codex_pragmatic",
            },
            pruning: {
              enabled: true,
              pruning_size: 0,
              preserve_tools: ["read"],
              prune: { reasoning: true, tool: true },
            },
          },
        },
        messages: [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "thinking" },
              { type: "tool-call", toolCallId: "read-1", toolName: "read", input: { file: "a.ts" } },
              {
                type: "tool-result",
                toolCallId: "read-1",
                toolName: "read",
                output: { type: "text", value: "preserved" },
              },
              {
                type: "tool-result",
                toolCallId: "shell-1",
                toolName: "shell",
                output: { type: "text", value: "removed" },
              },
            ],
          },
        ],
      }),
    )
    const assistant = prepared.messages.find((message) => message.role === "assistant") as any

    expect(assistant.content[0].text).toBe("[reasoning pruned: 8 chars]")
    expect(assistant.content[1].type).toBe("tool-call")
    expect(assistant.content[2].output.value).toBe("preserved")
    expect(assistant.content[3].output.value).toBe("[Tool output pruned: 7 chars]")
  })

  test("uses session metadata for resumed OpenCodez selection and pruning", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...baseInput,
        sessionID: "session-resumed",
        sessionMetadata: {
          opencodez: {
            selection: {
              system: "manual_core",
              tone: "manual_tone",
              systemManual: true,
              toneManual: true,
            },
            pruning: {
              enabled: true,
              pruning_size: 0,
            },
          },
        },
        config: {
          opencodez: {
            responses: {
              system: {
                default: "codex_gpt_5_5",
                "gpt-5.2": "codex_gpt_5_2",
              },
              tone: "codex_pragmatic",
            },
            pruning: {
              enabled: false,
              pruning_size: 20_000,
              preserve_tools: [],
              prune: { reasoning: true, tool: true },
            },
          },
        },
        model: {
          ...model,
          id: "gpt-5.2",
        },
        messages: [
          {
            role: "assistant",
            content: [{ type: "reasoning", text: "metadata pruning" }],
          },
        ],
      }),
    )
    const system = prepared.system.join("\n")
    const assistant = prepared.messages.find((message) => message.role === "assistant") as any

    expect(system).toContain("MANUAL SYSTEM PROMPT")
    expect(system).toContain("MANUAL TONE PROMPT")
    expect(system).not.toContain("CORE PROMPT")
    expect(assistant.content[0].text).toBe("[reasoning pruned: 16 chars]")
  })
})
