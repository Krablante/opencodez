import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SystemPrompt } from "../../src/session/system"

let tmp = ""
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR

describe("OpenCodez prompt library", () => {
  afterEach(async () => {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
    tmp = ""
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  })

  test("lists upstream builtins, Codex presets, and custom System prompts together", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-prompt-library-"))
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config", "opencodez")
    const { OpenCodezPromptLibrary } = await import("../../src/opencodez/prompt-library")
    const dirs = OpenCodezPromptLibrary.directories()

    await fs.mkdir(dirs.system, { recursive: true })
    await fs.writeFile(path.join(dirs.system, "custom_system.md"), "CUSTOM SYSTEM")

    const entries = await OpenCodezPromptLibrary.list()
    const names = entries.map((entry) => entry.name)

    expect(names).toContain("default")
    expect(names).toContain("gpt")
    expect(names).toContain("anthropic")
    expect(names).toContain("codex_gpt_5_2")
    expect(names).toContain("codex_gpt_5_2_codex")
    expect(names).toContain("codex_gpt_5_3_codex")
    expect(names).toContain("codex_gpt_5_4")
    expect(names).toContain("codex_gpt_5_4_mini")
    expect(names).toContain("codex_gpt_5_5")
    expect(names).toContain("codex_gpt_5_6_luna_terra")
    expect(names).toContain("codex_gpt_5_6_sol")
    expect(names).toContain("custom_system")
    expect(await OpenCodezPromptLibrary.readPrompt("default")).toBe(SystemPrompt.builtinPrompt("default"))
    expect(await OpenCodezPromptLibrary.readPrompt("custom_system")).toBe("CUSTOM SYSTEM")
  })

  test("lets prompt library files override builtin Core prompt names", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-prompt-library-"))
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config", "opencodez")
    const { OpenCodezPromptLibrary } = await import("../../src/opencodez/prompt-library")
    const dirs = OpenCodezPromptLibrary.directories()

    await fs.mkdir(dirs.system, { recursive: true })
    await fs.writeFile(path.join(dirs.system, "default.md"), "CUSTOM DEFAULT")

    const entry = await OpenCodezPromptLibrary.get("default")

    expect(entry?.source).toBe("library")
    expect(await OpenCodezPromptLibrary.readPrompt("default")).toBe("CUSTOM DEFAULT")
  })
})
