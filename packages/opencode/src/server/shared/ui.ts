import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src * data:`
export const DEFAULT_CSP = csp()

const WEB_SERVERS_SCRIPT_PATH = "/opencode-web-servers.js"
const DEFAULT_UI_ASSET_CACHE_MAX_AGE_SECONDS = 31_536_000

type UIAssetSettings = {
  cache: boolean
  compression: boolean
  cacheMaxAge: number
}

export function uiAssetSettings(env: NodeJS.ProcessEnv = process.env): UIAssetSettings {
  return {
    cache: envBool(env.OPENCODE_UI_ASSET_CACHE, true),
    compression: envBool(env.OPENCODE_UI_ASSET_COMPRESSION, true),
    cacheMaxAge: envPositiveInt(env.OPENCODE_UI_ASSET_CACHE_MAX_AGE, DEFAULT_UI_ASSET_CACHE_MAX_AGE_SECONDS),
  }
}

export function uiAssetHeaders(requestPath: string, mime: string, settings = uiAssetSettings()) {
  const headers = new Headers({ "content-type": mime })
  if (!settings.cache) return headers

  if (mime.startsWith("text/html") || requestPath === WEB_SERVERS_SCRIPT_PATH) {
    headers.set("cache-control", "no-cache")
    return headers
  }

  if (isImmutableUIAsset(requestPath)) {
    headers.set("cache-control", `public, max-age=${settings.cacheMaxAge}, immutable`)
  }

  return headers
}

export function compressUIAsset(
  requestPath: string,
  mime: string,
  body: Uint8Array,
  acceptEncoding = "",
  settings = uiAssetSettings(),
) {
  if (!settings.compression || !isCompressibleUIAsset(requestPath, mime, body)) return { body, encoding: undefined }

  if (acceptsEncoding(acceptEncoding, "br")) return { body: brotliCompressSync(body), encoding: "br" }
  if (acceptsEncoding(acceptEncoding, "gzip")) return { body: gzipSync(body), encoding: "gzip" }
  return { body, encoding: undefined }
}

function configuredWebServers() {
  const raw =
    process.env.OPENCODE_WEB_SERVERS_JSON ||
    (process.env.OPENCODE_WEB_SERVERS_JSON_B64
      ? Buffer.from(process.env.OPENCODE_WEB_SERVERS_JSON_B64, "base64").toString("utf8")
      : "")
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((server) => {
      if (
        server &&
        server.type === "http" &&
        typeof server.displayName === "string" &&
        typeof server.http?.url === "string"
      ) {
        return [{ type: "http", displayName: server.displayName, http: { url: server.http.url } }]
      }
      if (server && typeof server.name === "string" && typeof server.url === "string") {
        return [{ type: "http", displayName: server.name, http: { url: server.url } }]
      }
      return []
    })
  } catch {
    return []
  }
}

function webServersScript() {
  const servers = configuredWebServers()
  if (servers.length === 0) return ""
  return `(() => {
  try {
    const key = "opencode.global.dat:server";
    const seed = ${JSON.stringify(servers)};
    const raw = localStorage.getItem(key);
    const state = raw ? JSON.parse(raw) : {};
    const byUrl = new Map();
    for (const item of state.list || []) {
      if (item && item.http && item.http.url) byUrl.set(item.http.url, item);
    }
    for (const item of seed) {
      byUrl.set(item.http.url, { ...byUrl.get(item.http.url), ...item });
    }
    state.list = Array.from(byUrl.values());
    state.projects = state.projects || {};
    state.lastProject = state.lastProject || {};
    localStorage.setItem(key, JSON.stringify(state));
  } catch (error) {
    console.warn("failed to apply configured OpenCode web servers", error);
  }
})();`
}

function injectWebServersScript(body: string) {
  if (configuredWebServers().length === 0 || body.includes(WEB_SERVERS_SCRIPT_PATH)) return body
  const script = `<script src="${WEB_SERVERS_SCRIPT_PATH}"></script>`
  if (body.includes("</head>")) return body.replace("</head>", `${script}</head>`)
  return `${script}${body}`
}

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(requestPath: string, file: string, body: Uint8Array, acceptEncoding = "") {
  const mime = FSUtil.mimeType(file)
  const headers = uiAssetHeaders(requestPath, mime)
  if (mime.startsWith("text/html")) {
    const text = injectWebServersScript(new TextDecoder().decode(body))
    headers.set("content-security-policy", cspForHtml(text))
    return HttpServerResponse.text(text, { headers })
  }
  const compressed = compressUIAsset(requestPath, mime, body, acceptEncoding)
  if (compressed.encoding) {
    headers.set("content-encoding", compressed.encoding)
    headers.set("vary", "Accept-Encoding")
    headers.set("content-length", String(compressed.body.byteLength))
  }
  return HttpServerResponse.raw(compressed.body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
  acceptEncoding = "",
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(requestPath, file, body, acceptEncoding)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; client: HttpClient.HttpClient; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (path === WEB_SERVERS_SCRIPT_PATH) {
      return HttpServerResponse.text(webServersScript(), {
        headers: uiAssetHeaders(WEB_SERVERS_SCRIPT_PATH, "text/javascript; charset=utf-8"),
      })
    }

    if (embeddedWebUI)
      return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, request.headers["accept-encoding"])

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: ProxyUtil.headers(request.headers, { host: UI_UPSTREAM.host }),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = injectWebServersScript(yield* response.text)
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}

function isImmutableUIAsset(requestPath: string) {
  return requestPath.startsWith("/assets/")
}

function isCompressibleUIAsset(requestPath: string, mime: string, body: Uint8Array) {
  if (!isImmutableUIAsset(requestPath) || body.byteLength < 1024) return false
  if (mime.startsWith("text/")) return true
  return [
    "application/javascript",
    "text/javascript",
    "application/json",
    "application/wasm",
    "image/svg+xml",
    "font/ttf",
    "font/otf",
    "font/woff",
    "font/woff2",
  ].some((type) => mime.includes(type))
}

function acceptsEncoding(acceptEncoding: string, encoding: "br" | "gzip") {
  return acceptEncoding
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .some((item) => item === encoding || item.startsWith(`${encoding};`))
}

function envBool(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") return fallback
  return !["0", "false", "no", "off", "disabled"].includes(value.toLowerCase())
}

function envPositiveInt(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}
