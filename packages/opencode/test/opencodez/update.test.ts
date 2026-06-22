import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { OpenCodezUpdate } from "../../src/opencodez/update"

const originalFetch = globalThis.fetch
const originalUpdateTarget = process.env["OPENCODEZ_UPDATE_TARGET"]

async function withRestoredGlobals<T>(run: () => Promise<T>) {
  try {
    return await run()
  } finally {
    restoreGlobals()
  }
}

function restoreGlobals() {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
  if (originalUpdateTarget === undefined) delete process.env["OPENCODEZ_UPDATE_TARGET"]
  else process.env["OPENCODEZ_UPDATE_TARGET"] = originalUpdateTarget
}

function mockLatestRelease(tag: string) {
  ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async () =>
    new Response(
      JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/Krablante/opencodez/releases/tag/${tag}`,
        assets: [{ name: "opencodez-linux-x64.tar.gz", browser_download_url: "https://example.com/opencodez.tar.gz" }],
      }),
      { status: 200 },
    )
}

function mockReleaseDownload(input: { tag: string; asset: string; chunks: string[]; contentLength?: number }) {
  const encoder = new TextEncoder()
  let calls = 0
  ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async () => {
    calls++
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          tag_name: input.tag,
          html_url: `https://github.com/Krablante/opencodez/releases/tag/${input.tag}`,
          assets: [{ name: input.asset, browser_download_url: "https://example.com/opencodez" }],
        }),
        { status: 200 },
      )
    }

    const headers = new Headers()
    if (input.contentLength !== undefined) headers.set("content-length", String(input.contentLength))
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of input.chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
      { status: 200, headers },
    )
  }
}

async function updateTarget() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-update-test-"))
  const target = path.join(dir, "opencodez")
  process.env["OPENCODEZ_UPDATE_TARGET"] = target
  return target
}

function localAssetName() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
  return `opencodez-${platform}-${arch}`
}

describe("OpenCodezUpdate", () => {
  test("does not offer an older GitHub release as an update", async () => {
    await withRestoredGlobals(async () => {
      mockLatestRelease("v1.15.13+opencodez.1")

      const result = await OpenCodezUpdate.run({ check: true, current: "1.17.8" })

      expect(result.status).toBe("current")
      expect(result.message).toContain("installed 1.17.8")
    })
  })

  test("offers a newer GitHub release when one is available", async () => {
    await withRestoredGlobals(async () => {
      mockLatestRelease("v1.18.0")

      const result = await OpenCodezUpdate.run({ check: true, current: "1.17.8" })

      expect(result).toEqual({
        status: "available",
        message: "Latest OpenCodez release is v1.18.0: opencodez-linux-x64.tar.gz",
      })
    })
  })

  test("emits download progress while streaming a release asset", async () => {
    await withRestoredGlobals(async () => {
      const asset = localAssetName()
      const target = await updateTarget()
      const events: OpenCodezUpdate.UpdateEvent[] = []
      mockReleaseDownload({ tag: "v1.18.0", asset, chunks: ["open", "codez"], contentLength: 9 })

      const result = await OpenCodezUpdate.run({
        check: false,
        current: "1.17.8",
        onEvent: (event) => events.push(event),
      })

      expect(result).toEqual({ status: "updated", message: "Updated OpenCodez to v1.18.0." })
      expect(await fs.readFile(target, "utf8")).toBe("opencodez")
      expect(events.map((event) => event.type)).toEqual([
        "checking",
        "latest",
        "download-start",
        "download-progress",
        "download-progress",
        "installing",
      ])
      expect(events.filter((event) => event.type === "download-start")).toEqual([
        { type: "download-start", asset, totalBytes: 9 },
      ])
      expect(events.filter((event) => event.type === "download-progress")).toEqual([
        { type: "download-progress", asset, downloadedBytes: 4, totalBytes: 9 },
        { type: "download-progress", asset, downloadedBytes: 9, totalBytes: 9 },
      ])
    })
  })

  test("emits downloaded bytes when content length is unknown", async () => {
    await withRestoredGlobals(async () => {
      const asset = localAssetName()
      const events: OpenCodezUpdate.UpdateEvent[] = []
      mockReleaseDownload({ tag: "v1.18.0", asset, chunks: ["abc"] })
      await updateTarget()

      const result = await OpenCodezUpdate.run({
        check: false,
        current: "1.17.8",
        onEvent: (event) => events.push(event),
      })

      expect(result.status).toBe("updated")
      expect(events.filter((event) => event.type === "download-start")).toEqual([
        { type: "download-start", asset, totalBytes: undefined },
      ])
      expect(events.filter((event) => event.type === "download-progress")).toEqual([
        { type: "download-progress", asset, downloadedBytes: 3, totalBytes: undefined },
      ])
    })
  })
})
