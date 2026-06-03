import { describe, expect, test } from "bun:test"
import { OpenCodezSession } from "../../src/opencodez/session"

const config = {
  opencodez: {
    responses: {
      system: {
        default: "default-system",
        "gpt-5.2": "model-system",
      },
      tone: "default-tone",
    },
    pruning: {
      enabled: true,
      pruning_size: 20_000,
      preserve_tools: [],
      prune: { reasoning: true, tool: true },
    },
  },
}

const mappedDefaults = [
  { modelID: "gpt-5.2", system: "codex_gpt_5_2" },
  { modelID: "gpt-5.2-codex", system: "codex_gpt_5_2_codex" },
  { modelID: "gpt-5.3-codex", system: "codex_gpt_5_3_codex" },
  { modelID: "gpt-5.3-codex-spark", system: "codex_gpt_5_3_codex" },
  { modelID: "gpt-5.4", system: "codex_gpt_5_4" },
  { modelID: "gpt-5.4-mini", system: "codex_gpt_5_4_mini" },
  { modelID: "gpt-5.5", system: "codex_gpt_5_5" },
] as const

describe("OpenCodez session-bound state", () => {
  test("restores manual System and Tone from session metadata", () => {
    const metadata = {
      opencodez: {
        selection: {
          system: "manual-system",
          tone: "manual-tone",
          systemManual: true,
          toneManual: true,
        },
      },
    }

    expect(
      OpenCodezSession.effective({
        config,
        modelID: "gpt-5.2",
        sessionID: "metadata-selection",
        metadata,
      }),
    ).toEqual({
      system: "manual-system",
      tone: "manual-tone",
      systemManual: true,
      toneManual: true,
    })
  })

  test("merges new manual Tone with restored manual System", () => {
    const metadata = {
      opencodez: {
        selection: {
          system: "persisted-system",
          systemManual: true,
        },
      },
    }

    OpenCodezSession.apply("metadata-merge", { tone: "new-tone", toneManual: true }, metadata)

    expect(
      OpenCodezSession.effective({
        config,
        modelID: "gpt-5.2",
        sessionID: "metadata-merge",
        metadata,
      }),
    ).toEqual({
      system: "persisted-system",
      tone: "new-tone",
      systemManual: true,
      toneManual: true,
    })
  })

  test("uses model defaults for sessions without manual metadata", () => {
    expect(
      OpenCodezSession.effective({
        config,
        modelID: "gpt-5.2",
        sessionID: "automatic-defaults",
      }),
    ).toEqual({
      system: "model-system",
      tone: "default-tone",
      systemManual: false,
      toneManual: false,
    })
  })

  test("uses built-in Codex defaults only for OpenAI Responses GPT", () => {
    expect(
      OpenCodezSession.effective({
        model: {
          id: "alias-gpt55",
          providerID: "openai",
          api: { id: "gpt-5.5", npm: "@ai-sdk/openai" },
        },
      }),
    ).toEqual({
      system: "codex_gpt_5_5",
      tone: "codex_pragmatic",
      systemManual: false,
      toneManual: false,
    })

    expect(
      OpenCodezSession.effective({
        model: {
          id: "deepseek-chat",
          providerID: "deepseek",
          family: "deepseek",
          api: { id: "deepseek-chat" },
        },
      }),
    ).toEqual({
      system: undefined,
      tone: undefined,
      systemManual: false,
      toneManual: false,
    })
  })

  test("maps built-in Codex System defaults for OpenAI Responses GPT variants", () => {
    mappedDefaults.forEach((item) => {
      expect(
        OpenCodezSession.effective({
          model: {
            id: item.modelID,
            providerID: "openai",
            api: { id: item.modelID, npm: "@ai-sdk/openai" },
          },
        }),
      ).toMatchObject({
        system: item.system,
        tone: "codex_pragmatic",
        systemManual: false,
        toneManual: false,
      })
    })
  })

  test("reports concrete System prompt ids for the TUI indicator", () => {
    const deepseek = {
      id: "deepseek-chat",
      providerID: "deepseek",
      family: "deepseek",
      api: { id: "deepseek-chat" },
    }

    expect(OpenCodezSession.effective({ model: deepseek }).system).toBeUndefined()
    expect(OpenCodezSession.indicator({ model: deepseek })).toEqual({
      system: "default",
      tone: undefined,
      systemManual: false,
      toneManual: false,
    })

    expect(
      OpenCodezSession.indicator({
        model: {
          id: "claude-sonnet-4-5-20250929",
          providerID: "anthropic",
          family: "anthropic",
          api: { id: "claude-sonnet-4-5-20250929" },
        },
      }).system,
    ).toBe("anthropic")

    expect(
      OpenCodezSession.indicator({
        model: {
          id: "gpt-5.5",
          providerID: "openai",
          api: { id: "gpt-5.5", npm: "@ai-sdk/openai" },
        },
      }),
    ).toMatchObject({
      system: "codex_gpt_5_5",
      tone: "codex_pragmatic",
    })
  })

  test("reflects manual System and Tone choices in the TUI indicator", () => {
    const model = {
      id: "deepseek-chat",
      providerID: "deepseek",
      family: "deepseek",
      api: { id: "deepseek-chat" },
    }

    OpenCodezSession.apply(
      "indicator-manual",
      {
        system: "codex_gpt_5_5",
        tone: "codex_pragmatic",
        systemManual: true,
        toneManual: true,
      },
      {},
    )

    expect(
      OpenCodezSession.indicator({
        model,
        sessionID: "indicator-manual",
      }),
    ).toEqual({
      system: "codex_gpt_5_5",
      tone: "codex_pragmatic",
      systemManual: true,
      toneManual: true,
    })
  })

  test("restores and serializes pruning overrides without config rewrites", () => {
    const metadata = {
      keep: "unchanged",
      opencodez: {
        pruning: {
          enabled: false,
          pruning_size: 0,
        },
      },
    }

    expect(
      OpenCodezSession.effectivePruning({
        config,
        sessionID: "metadata-pruning",
        metadata,
      }),
    ).toMatchObject({
      enabled: false,
      pruning_size: 0,
      preserve_tools: [],
      prune: { reasoning: true, tool: true },
    })

    OpenCodezSession.setPruning("metadata-pruning", { enabled: true }, metadata)

    expect(OpenCodezSession.metadataWithSessionState(metadata, "metadata-pruning")).toEqual({
      keep: "unchanged",
      opencodez: {
        version: 1,
        pruning: {
          enabled: true,
          pruning_size: 0,
        },
      },
    })
  })

  test("carries pending /new selection into the created session", () => {
    OpenCodezSession.resetPending({ system: "pending-system", systemManual: true })

    expect(OpenCodezSession.pendingMetadata()).toEqual({
      opencodez: {
        version: 1,
        selection: {
          system: "pending-system",
          systemManual: true,
        },
      },
    })

    OpenCodezSession.consumePending("pending-created")

    expect(
      OpenCodezSession.effective({
        config,
        modelID: "gpt-5.2",
        sessionID: "pending-created",
      }).system,
    ).toBe("pending-system")
  })

  test("/new reset clears stale pending pruning overrides", () => {
    OpenCodezSession.setPruning(undefined, { pruning_size: 0 })
    OpenCodezSession.resetPending({})

    expect(OpenCodezSession.pendingMetadata()).toEqual({})
    expect(
      OpenCodezSession.effectivePruning({
        config,
      }).pruning_size,
    ).toBe(20_000)
  })
})
