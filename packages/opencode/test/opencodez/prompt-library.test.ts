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

  test("lists upstream builtins, Codex presets, and custom Core prompts together", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-prompt-library-"))
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config", "opencodez")
    const { OpenCodezPromptLibrary } = await import("../../src/opencodez/prompt-library")
    const dirs = OpenCodezPromptLibrary.directories()

    await fs.mkdir(dirs.core, { recursive: true })
    await fs.writeFile(path.join(dirs.core, "custom_core.md"), "CUSTOM CORE")

    const entries = await OpenCodezPromptLibrary.list("core")
    const names = entries.map((entry) => entry.name)

    expect(names).toContain("default")
    expect(names).toContain("gpt")
    expect(names).toContain("anthropic")
    expect(names).toContain("codex_gpt_5_5")
    expect(names).toContain("custom_core")
    expect(await OpenCodezPromptLibrary.readPrompt("core", "default")).toBe(SystemPrompt.builtinPrompt("default"))
    expect(await OpenCodezPromptLibrary.readPrompt("core", "custom_core")).toBe("CUSTOM CORE")
  })

  test("lets prompt library files override builtin Core prompt names", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-prompt-library-"))
    process.env.OPENCODE_CONFIG_DIR = path.join(tmp, "config", "opencodez")
    const { OpenCodezPromptLibrary } = await import("../../src/opencodez/prompt-library")
    const dirs = OpenCodezPromptLibrary.directories()

    await fs.mkdir(dirs.core, { recursive: true })
    await fs.writeFile(path.join(dirs.core, "default.md"), "CUSTOM DEFAULT")

    const entry = await OpenCodezPromptLibrary.get("core", "default")

    expect(entry?.source).toBe("library")
    expect(await OpenCodezPromptLibrary.readPrompt("core", "default")).toBe("CUSTOM DEFAULT")
  })
})
