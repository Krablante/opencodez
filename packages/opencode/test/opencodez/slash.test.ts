import { describe, expect, test } from "bun:test"
import { OpenCodezSession } from "../../src/opencodez/session"
import { OpenCodezSlash } from "../../src/opencodez/slash"

describe("OpenCodezSlash", () => {
  test("parses /new system and tone flags", () => {
    expect(OpenCodezSlash.parse("/new --system codex_gpt_5_5 -o codex_pragmatic")).toEqual({
      type: "new",
      system: "codex_gpt_5_5",
      tone: "codex_pragmatic",
      template: undefined,
    })
  })

  test("rejects template combined with system or tone in one /new command", () => {
    expect(OpenCodezSlash.parse("/new --template gpt55 --system codex_gpt_5_5")).toEqual({
      type: "new",
      error: "--template cannot be combined with --system or --tone.",
    })
  })

  test("parses selectors and pruning commands", () => {
    expect(OpenCodezSlash.parse("/system codex_gpt_5_5")).toEqual({ type: "system", name: "codex_gpt_5_5" })
    expect(OpenCodezSlash.parse("/tone")).toEqual({ type: "tone", name: undefined })
    expect(OpenCodezSlash.parse("/template gpt55")).toEqual({ type: "template", name: "gpt55" })
    expect(OpenCodezSlash.parse("/pruning size 0")).toEqual({ type: "pruning", action: "size", size: 0 })
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
