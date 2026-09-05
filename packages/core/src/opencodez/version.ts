import semver from "semver"

export function normalizeOpenCodezVersion(value: string) {
  return value.replace(/^v/, "")
}

export function isProductionOpenCodezVersion(value: string) {
  return /^\d+\.\d+\.\d+\+opencodez\.\d+$/.test(normalizeOpenCodezVersion(value))
}

export function isCurrentOrNewerOpenCodezVersion(current: string, latest: string) {
  const currentNormalized = normalizeOpenCodezVersion(current)
  const latestNormalized = normalizeOpenCodezVersion(latest)
  if (currentNormalized === latestNormalized) return true

  const currentVersion = parseOpenCodezVersion(currentNormalized)
  const latestVersion = parseOpenCodezVersion(latestNormalized)
  if (!currentVersion || !latestVersion) return false

  const precedence = semver.compare(currentVersion, latestVersion)
  if (precedence !== 0) return precedence > 0

  // Semver precedence intentionally ignores build metadata. OpenCodez releases use
  // build metadata for fork builds, so compare our opencodez.N sequence explicitly.
  const currentBuild = opencodezBuildNumber(currentNormalized)
  const latestBuild = opencodezBuildNumber(latestNormalized)
  if (latestBuild === undefined) return currentBuild !== undefined
  if (currentBuild === undefined) return false
  return currentBuild >= latestBuild
}

function parseOpenCodezVersion(value: string) {
  return semver.valid(normalizeOpenCodezVersion(value))
}

function opencodezBuildNumber(value: string) {
  const parsed = semver.parse(normalizeOpenCodezVersion(value))
  const build = parsed?.build.join(".") ?? ""
  const match = /^opencodez\.(\d+)$/.exec(build)
  return match ? Number(match[1]) : undefined
}
