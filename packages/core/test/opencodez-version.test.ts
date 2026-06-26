import { describe, expect, test } from "bun:test"
import { isCurrentOrNewerOpenCodezVersion } from "../src/opencodez/version"

describe("OpenCodez version checks", () => {
  test("treats newer build metadata releases as updates", () => {
    expect(isCurrentOrNewerOpenCodezVersion("1.17.11", "v1.17.11+opencodez.4")).toBe(false)
    expect(isCurrentOrNewerOpenCodezVersion("1.17.11+opencodez.3", "v1.17.11+opencodez.4")).toBe(false)
    expect(isCurrentOrNewerOpenCodezVersion("1.17.11+opencodez.4", "v1.17.11+opencodez.4")).toBe(true)
  })

  test("treats higher OpenCodez build metadata as current", () => {
    expect(isCurrentOrNewerOpenCodezVersion("1.17.11+opencodez.4", "v1.17.11+opencodez.3")).toBe(true)
  })

  test("still treats higher semver versions as current", () => {
    expect(isCurrentOrNewerOpenCodezVersion("1.17.12", "v1.17.11+opencodez.4")).toBe(true)
  })
})
