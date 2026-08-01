import { beforeEach, describe, expect, test } from "bun:test"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"

const model = (id: string) => ({
  id,
  providerID: "openai",
  api: { id, npm: "@ai-sdk/openai" },
})

describe("OpenCodezSession", () => {
  beforeEach(() => OpenCodezSession.resetPending())

  test.each([
    ["gpt-5.5", "codex_gpt_5_5"],
    ["gpt-5.6-luna", "codex_gpt_5_6_luna_terra"],
    ["gpt-5.6-terra", "codex_gpt_5_6_luna_terra"],
    ["gpt-5.6-sol", "codex_gpt_5_6_sol"],
  ])("maps %s to %s", (modelID, system) => {
    expect(OpenCodezSession.effective({ config: {}, model: model(modelID) })).toMatchObject({
      system,
      systemManual: false,
    })
  })

  test("recomputes inherited System when the model changes", () => {
    const luna = OpenCodezSession.effective({ config: {}, model: model("gpt-5.6-luna") })
    const sol = OpenCodezSession.effective({ config: {}, model: model("gpt-5.6-sol") })

    expect(luna.system).toBe("codex_gpt_5_6_luna_terra")
    expect(sol.system).toBe("codex_gpt_5_6_sol")
  })

  test("persists explicit None as a disabled System", () => {
    const metadata = OpenCodezSession.metadataWithSelection(undefined, OpenCodezSession.disable())
    expect(OpenCodezSession.fromMetadata(metadata).selection).toEqual({ system: null, systemManual: true })
  })
})
