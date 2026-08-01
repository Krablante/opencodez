import { describe, expect, test } from "bun:test"
import { OpenCodezSession } from "@opencode-ai/core/opencodez/session"
import { OpenCodezSlash } from "@opencode-ai/core/opencodez/slash"

describe("OpenCodezSlash", () => {
  test("parses System commands", () => {
    expect(OpenCodezSlash.parse("/system codex_gpt_5_5")).toEqual({ type: "system", name: "codex_gpt_5_5" })
  })

  test("notifies TUI subscribers when session selection changes", () => {
    let observed = 0
    const unsubscribe = OpenCodezSession.subscribe(() => observed++)
    const before = OpenCodezSession.version()

    OpenCodezSession.apply("session-version-test", {
      system: "codex_gpt_5_5",
      systemManual: true,
    })

    unsubscribe()
    expect(OpenCodezSession.version()).toBeGreaterThan(before)
    expect(observed).toBe(1)
  })
})
