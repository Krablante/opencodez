import { describe, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { compressUIAsset, uiAssetHeaders, uiAssetSettings } from "../../src/server/shared/ui"

describe("UI asset delivery", () => {
  test("caches hashed assets and leaves runtime files uncached", () => {
    const asset = uiAssetHeaders("/assets/index-abc123.js", "text/javascript", uiAssetSettings({}))
    expect(asset.get("cache-control")).toBe("public, max-age=31536000, immutable")

    const html = uiAssetHeaders("/", "text/html", uiAssetSettings({}))
    expect(html.get("cache-control")).toBe("no-cache")

    const servers = uiAssetHeaders("/opencode-web-servers.js", "text/javascript", uiAssetSettings({}))
    expect(servers.get("cache-control")).toBe("no-cache")
  })

  test("compresses text-like assets by default", () => {
    const body = new TextEncoder().encode("const value = 1;\n".repeat(200))
    const result = compressUIAsset("/assets/index-abc123.js", "text/javascript", body, "gzip")

    expect(result.encoding).toBe("gzip")
    expect(gunzipSync(result.body).toString()).toBe(new TextDecoder().decode(body))
  })

  test("allows operators to disable cache and compression", () => {
    const settings = uiAssetSettings({ OPENCODE_UI_ASSET_CACHE: "0", OPENCODE_UI_ASSET_COMPRESSION: "false" })
    const headers = uiAssetHeaders("/assets/index-abc123.js", "text/javascript", settings)
    expect(headers.get("cache-control")).toBeNull()

    const body = new TextEncoder().encode("const value = 1;\n".repeat(200))
    const result = compressUIAsset("/assets/index-abc123.js", "text/javascript", body, "gzip", settings)
    expect(result.encoding).toBeUndefined()
    expect(result.body).toBe(body)
  })
})
