import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { Effect } from "effect"

let LLMRequestPrep: typeof import("../../src/session/llm/request").LLMRequestPrep

const previousConfigDir = process.env.OPENCODE_CONFIG_DIR
let tmp = ""

const provider = {
  id: "openai",
  name: "OpenAI",
  source: "config",
  env: [],
  models: {},
  options: {},
} as any

const model = {
  id: "gpt-5.5",
  providerID: "openai",
  api: { id: "gpt-5.5", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5.5",
  family: "gpt-5.5",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 200_000, output: 100_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
  variants: {},
} as any

const input = {
  user: { id: "msg-user", system: undefined, tools: {}, model: {} },
  sessionID: "session-test",
  agent: {
    name: "build",
    mode: "primary" as const,
    permission: [],
    options: {},
  },
  permission: [],
  system: ["EXTRA SYSTEM"],
  messages: [],
  tools: {},
  model,
  provider,
  auth: undefined,
  plugin: { trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output) },
  flags: { outputTokenMax: undefined, client: "cli" },
  isWorkflow: false,
  config: {},
} as any

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-request-prep-"))
  process.env.OPENCODE_APP_NAME = "opencodez"
  process.env.OPENCODE_CLI_NAME = "opencodez"
  process.env.OPENCODEZ = "1"
  process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config", "opencodez")
  const root = path.join(process.env.OPENCODE_CONFIG_DIR, "prompts", "core")
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "codex_gpt_5_5.md"), "GPT 5.5 SYSTEM")
  await fs.writeFile(path.join(root, "codex_gpt_5_6_luna_terra.md"), "GPT 5.6 LUNA TERRA SYSTEM")
  await fs.writeFile(path.join(root, "codex_gpt_5_6_sol.md"), "GPT 5.6 SOL SYSTEM")
  await fs.writeFile(path.join(root, "manual_system.md"), "MANUAL SYSTEM")
  LLMRequestPrep = (await import("../../src/session/llm/request")).LLMRequestPrep
})

afterAll(async () => {
  OpenCodezSession.resetPending()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
})

describe("LLMRequestPrep", () => {
  test.each([
    ["gpt-5.5", "GPT 5.5 SYSTEM"],
    ["gpt-5.6-luna", "GPT 5.6 LUNA TERRA SYSTEM"],
    ["gpt-5.6-terra", "GPT 5.6 LUNA TERRA SYSTEM"],
    ["gpt-5.6-sol", "GPT 5.6 SOL SYSTEM"],
  ])("uses the mapped System for %s", async (modelID, expected) => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...input,
        sessionID: `session-${modelID}`,
        model: { ...model, id: modelID, api: { ...model.api, id: modelID } },
      }),
    )

    expect(prepared.system.join("\n")).toContain(expected)
  })

  test("uses manual System", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...input,
        sessionID: "session-manual-system",
        sessionMetadata: {
          opencodez: { selection: { system: "manual_system", systemManual: true } },
        },
      }),
    )
    const system = prepared.system.join("\n")

    expect(system).toContain("MANUAL SYSTEM")
  })

  test("explicit None disables the model System default", async () => {
    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        ...input,
        sessionID: "session-none",
        sessionMetadata: {
          opencodez: { selection: { system: null, systemManual: true } },
        },
      }),
    )

    expect(prepared.system.join("\n")).not.toContain("GPT 5.5 SYSTEM")
  })
})
