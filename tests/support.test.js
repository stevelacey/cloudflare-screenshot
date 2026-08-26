import { describe, expect, it } from "vitest"
import { regexMerge } from "../src/support.js"

describe("regexMerge", () => {
  it("merges plain strings and regexes into a single pattern", () => {
    const merged = regexMerge(/^foo/, "-", /bar$/)
    expect(merged.source).toBe("^foo-bar$")
    expect(merged.test("foo-bar")).toBe(true)
  })

  it("escapes regex-special characters in plain string args", () => {
    const merged = regexMerge("a.b+c")
    expect(merged.source).toBe("a\\.b\\+c")
    expect(merged.test("a.b+c")).toBe(true)
    expect(merged.test("axbyc")).toBe(false)
  })

  it("auto-detects a leading anchor and adds it to the merged pattern", () => {
    const merged = regexMerge(/^foo/, "bar")
    expect(merged.source).toBe("^foobar")
  })

  it("auto-detects a trailing anchor and adds it to the merged pattern", () => {
    const merged = regexMerge("foo", /bar$/)
    expect(merged.source).toBe("foobar$")
  })

  it("does not re-anchor once the start/end has already been detected", () => {
    const merged = regexMerge(/^foo/, /^bar/, /baz$/, /qux$/)
    expect(merged.source).toBe("^foobarbazqux$")
  })

  it("treats an escaped dollar sign as a literal, not an anchor", () => {
    const merged = regexMerge(/foo\$/)
    expect(merged.source).toBe("foo\\$")
    expect(merged.test("foo$")).toBe(true)
  })

  it("treats an escaped backslash before a dollar sign as a real anchor", () => {
    const merged = regexMerge(/foo\\$/)
    expect(merged.source).toBe("foo\\\\$")
    expect(merged.test("foo\\")).toBe(true)
    expect(merged.test("foo\\bar")).toBe(false)
  })

  it("strips detected anchors from the individual pattern by default", () => {
    const merged = regexMerge(/^foo$/)
    expect(merged.source).toBe("^foo$")
  })

  it("keeps embedded anchors when stripAnchors is disabled", () => {
    const merged = regexMerge(/^foo/, "bar", { stripAnchors: false, anchor: false })
    expect(merged.source).toBe("^foobar")
  })

  it("forces anchors via the anchor option even without an anchored input", () => {
    const merged = regexMerge("foo", "bar", { anchor: true })
    expect(merged.source).toBe("^foobar$")
  })

  it("suppresses auto-detected anchors via the anchor option", () => {
    const merged = regexMerge(/^foo$/, { anchor: false })
    expect(merged.source).toBe("foo")
    expect(merged.test("xfoox")).toBe(true)
  })

  it("merges and dedupes flags across regex args", () => {
    const merged = regexMerge(/foo/i, /bar/gi)
    expect([...merged.flags].sort().join("")).toBe("gi")
  })

  it("uses explicit flags instead of auto-merging them", () => {
    const merged = regexMerge(/foo/i, /bar/g, { flags: "m" })
    expect(merged.flags).toBe("m")
  })

  it("treats a trailing regex or string arg as pattern input, not options", () => {
    const merged = regexMerge("foo", /bar/)
    expect(merged.source).toBe("foobar")
  })

  it("returns an empty-matching pattern when called with no args", () => {
    const merged = regexMerge()
    expect(merged.source).toBe("(?:)")
  })
})
