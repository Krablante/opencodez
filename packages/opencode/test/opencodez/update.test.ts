import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodezUpdate } from "../../src/opencodez/update"

const originalFetch = globalThis.fetch

afterEach(() => {
  ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
})

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

describe("OpenCodezUpdate", () => {
  test("does not offer an older GitHub release as an update", async () => {
    mockLatestRelease("v1.15.13+opencodez.1")

    const result = await OpenCodezUpdate.run({ check: true, current: "1.17.8" })

    expect(result.status).toBe("current")
    expect(result.message).toContain("installed 1.17.8")
  })

  test("offers a newer GitHub release when one is available", async () => {
    mockLatestRelease("v1.18.0")

    const result = await OpenCodezUpdate.run({ check: true, current: "1.17.8" })

    expect(result).toEqual({
      status: "available",
      message: "Latest OpenCodez release is v1.18.0: opencodez-linux-x64.tar.gz",
    })
  })
})
