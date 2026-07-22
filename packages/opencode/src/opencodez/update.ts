import { z } from "zod"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { isCurrentOrNewerOpenCodezVersion } from "@opencode-ai/core/opencodez/version"

const RELEASE_REPOSITORY = process.env["OPENCODEZ_UPDATE_REPOSITORY"] ?? "Krablante/opencodez"
const RELEASES_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`
const MANAGED_INSTALL_HELPER = "/usr/local/sbin/opencodez-install"

const Asset = z.object({
  name: z.string(),
  browser_download_url: z.string(),
})

const Release = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z.array(Asset),
})

export * as OpenCodezUpdate from "./update"

export interface Result {
  status: "current" | "available" | "unavailable" | "updated" | "error"
  message: string
}

export type UpdateEvent =
  | { type: "checking" }
  | { type: "latest"; tag: string; url: string }
  | { type: "download-start"; asset: string; totalBytes?: number }
  | { type: "download-progress"; asset: string; downloadedBytes: number; totalBytes?: number }
  | { type: "installing"; asset: string; target: string }

export async function run(input: {
  check: boolean
  current?: string
  onEvent?: (event: UpdateEvent) => void
}): Promise<Result> {
  let release: z.infer<typeof Release>
  try {
    emit(input.onEvent, { type: "checking" })
    const response = await fetch(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opencodez-local-updater",
      },
    })
    if (!response.ok) {
      return {
        status: "unavailable",
        message: `No OpenCodez release is available yet (${response.status} ${response.statusText}).`,
      }
    }
    release = Release.parse(await response.json())
    emit(input.onEvent, { type: "latest", tag: release.tag_name, url: release.html_url })
  } catch (error) {
    return {
      status: "error",
      message: `Unable to check OpenCodez releases: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const current = input.current
  if (current && isCurrentOrNewerOpenCodezVersion(current, release.tag_name)) {
    return {
      status: "current",
      message: `OpenCodez is already current (installed ${current}, latest release ${release.tag_name}).`,
    }
  }

  const asset = selectAsset(release.assets)
  if (input.check) {
    if (!asset) {
      return {
        status: "available",
        message: `Latest OpenCodez release is ${release.tag_name}, but no matching local asset is published yet: ${release.html_url}`,
      }
    }
    return {
      status: "available",
      message: `Latest OpenCodez release is ${release.tag_name}: ${asset.name}`,
    }
  }

  if (!asset) {
    return {
      status: "unavailable",
      message: `Latest OpenCodez release is ${release.tag_name}, but no matching local asset is published yet: ${release.html_url}`,
    }
  }

  const target = installTarget()
  if (!target) {
    return {
      status: "unavailable",
      message:
        "OpenCodez update found a release asset, but this source checkout is not a self-updatable release binary. Set OPENCODEZ_UPDATE_TARGET to test replacement explicitly.",
    }
  }

  try {
    const response = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "opencodez-local-updater" },
    })
    if (!response.ok) {
      return {
        status: "error",
        message: `Unable to download ${asset.name}: ${response.status} ${response.statusText}`,
      }
    }
    const bytes = await downloadAsset(response, { asset: asset.name, onEvent: input.onEvent })
    emit(input.onEvent, { type: "installing", asset: asset.name, target })
    await installAsset({ name: asset.name, bytes, target })
    return {
      status: "updated",
      message: `Updated OpenCodez to ${release.tag_name}.`,
    }
  } catch (error) {
    return {
      status: "error",
      message: `Unable to update OpenCodez: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function emit(onEvent: ((event: UpdateEvent) => void) | undefined, event: UpdateEvent) {
  onEvent?.(event)
}

async function downloadAsset(
  response: Response,
  input: { asset: string; onEvent?: (event: UpdateEvent) => void },
): Promise<Uint8Array> {
  const totalBytes = parseContentLength(response.headers.get("content-length"))
  emit(input.onEvent, { type: "download-start", asset: input.asset, totalBytes })

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    emit(input.onEvent, {
      type: "download-progress",
      asset: input.asset,
      downloadedBytes: bytes.byteLength,
      totalBytes,
    })
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let downloadedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      chunks.push(chunk)
      downloadedBytes += chunk.byteLength
      emit(input.onEvent, { type: "download-progress", asset: input.asset, downloadedBytes, totalBytes })
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 1) return chunks[0]
  const bytes = new Uint8Array(downloadedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseContentLength(value: string | null) {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function selectAsset(assets: Array<z.infer<typeof Asset>>) {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch
  const names = [
    `opencodez-${platform}-${arch}`,
    `opencodez-${platform}-${arch}.tar.gz`,
    `opencodez-${platform}-${arch}.zip`,
    `opencodez-${platform}-${arch}.gz`,
  ]
  return assets.find((asset) => names.includes(asset.name))
}

function installTarget() {
  const explicit = process.env["OPENCODEZ_UPDATE_TARGET"]
  if (explicit) return explicit
  const binary = path.basename(process.execPath).toLowerCase()
  if (binary === "opencodez" || binary === "opencodez.exe") return process.execPath
  return undefined
}

async function installAsset(input: { name: string; bytes: Uint8Array; target: string }) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "opencodez-update-"))
  const tmp = path.join(path.dirname(input.target), `.${path.basename(input.target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    const archive = path.join(work, "asset")
    const binary = path.join(work, process.platform === "win32" ? "opencodez.exe" : "opencodez")
    await Bun.write(archive, input.bytes)
    if (input.name.endsWith(".tar.gz")) {
      await extractTarGz({ archive, work, binary })
    } else if (input.name.endsWith(".zip")) {
      await extractZip({ archive, binary })
    } else if (input.name.endsWith(".gz")) {
      await extractGzip({ archive, binary })
    } else {
      await fs.rename(archive, binary)
    }
    await fs.chmod(binary, 0o755)
    try {
      await fs.copyFile(binary, tmp)
      await fs.chmod(tmp, 0o755)
      await fs.rename(tmp, input.target)
    } catch (error) {
      await fs.rm(tmp, { force: true })
      if (process.platform === "win32" || !isPermissionError(error)) throw error
      await installWithSudo({ binary, target: input.target, tmp })
    }
  } finally {
    await fs.rm(tmp, { force: true })
    await fs.rm(work, { recursive: true, force: true })
  }
}

async function installWithSudo(input: { binary: string; target: string; tmp: string }) {
  try {
    if (input.target === "/usr/local/bin/opencodez" && (await tryManagedInstall(input.binary))) return
    await runSudo(["install", "-m", "0755", input.binary, input.tmp])
    await runSudo(["mv", "-f", input.tmp, input.target])
  } catch (error) {
    await runSudo(["rm", "-f", input.tmp]).catch(() => undefined)
    throw new Error(
      `Cannot replace protected install target ${input.target}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function tryManagedInstall(binary: string) {
  const available = await fs
    .stat(MANAGED_INSTALL_HELPER)
    .then((stat) => stat.isFile())
    .catch(() => false)
  if (!available) return false
  const proc = Bun.spawn(["sudo", "-n", "--", MANAGED_INSTALL_HELPER, binary], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  })
  return (await proc.exited) === 0
}

async function runSudo(args: string[]) {
  const proc = Bun.spawn(["sudo", "--", ...args], {
    stdin: "inherit",
    stdout: "ignore",
    stderr: "inherit",
  })
  const exit = await proc.exited
  if (exit === 0) return
  throw new Error(`sudo ${args[0]} failed with exit code ${exit}`)
}

function isPermissionError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false
  const code = String(error.code)
  return code === "EACCES" || code === "EPERM"
}

async function extractTarGz(input: { archive: string; work: string; binary: string }) {
  const name = process.platform === "win32" ? "opencodez.exe" : "opencodez"
  const proc = Bun.spawn(["tar", "-xzf", input.archive, "-C", input.work, name], { stdout: "ignore", stderr: "pipe" })
  const exit = await proc.exited
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text())
  if (name !== path.basename(input.binary)) await fs.rename(path.join(input.work, name), input.binary)
}

async function extractZip(input: { archive: string; binary: string }) {
  const name = process.platform === "win32" ? "opencodez.exe" : "opencodez"
  const proc = Bun.spawn(["unzip", "-p", input.archive, name], { stdout: "pipe", stderr: "pipe" })
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
  const exit = await proc.exited
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text())
  await Bun.write(input.binary, bytes)
}

async function extractGzip(input: { archive: string; binary: string }) {
  const proc = Bun.spawn(["gzip", "-dc", input.archive], { stdout: "pipe", stderr: "pipe" })
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
  const exit = await proc.exited
  if (exit !== 0) throw new Error(await new Response(proc.stderr).text())
  await Bun.write(input.binary, bytes)
}
