import puppeteer from "@cloudflare/puppeteer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import worker, { Browser } from "../src/index.js"
import { prepare, record } from "../src/video.js"

vi.mock("@cloudflare/puppeteer", () => ({
  default: { launch: vi.fn() },
}))

vi.mock("../src/video.js", () => ({
  prepare: vi.fn().mockResolvedValue(undefined),
  record: vi.fn().mockResolvedValue("video-bytes"),
}))

function createMockPage() {
  return {
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue({ ok: () => true, status: () => 200 }),
    pdf: vi.fn().mockResolvedValue("pdf-bytes"),
    screenshot: vi.fn().mockResolvedValue("png-bytes"),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockBrowserInstance() {
  const page = createMockPage()
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  }
  return {
    page,
    context,
    isConnected: vi.fn().mockReturnValue(true),
    createBrowserContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

function createStorage() {
  return { setAlarm: vi.fn().mockResolvedValue(undefined) }
}

function createEnv(overrides = {}) {
  const stub = { fetch: vi.fn() }
  return {
    MYBROWSER: {},
    SCREENSHOTS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    BROWSER: {
      idFromName: vi.fn((name) => name),
      get: vi.fn(() => stub),
    },
    stub,
    ...overrides,
  }
}

function createCtx() {
  return { waitUntil: vi.fn() }
}

describe("worker.fetch", () => {
  let env
  let ctx

  beforeEach(() => {
    env = createEnv()
    ctx = createCtx()
  })

  it("returns an empty 404 for the root instead of screenshotting it", async () => {
    const response = await worker.fetch({ url: "https://example.com/screenshots/" }, env, ctx)

    expect(response.status).toBe(404)
    expect(await response.text()).toBe("")
    expect(env.SCREENSHOTS.get).not.toHaveBeenCalled()
  })

  it("serves a fresh cached screenshot without triggering a background refresh", async () => {
    env.SCREENSHOTS.get.mockResolvedValue({
      body: "cached-bytes",
      uploaded: new Date().toISOString(),
    })

    const response = await worker.fetch({ url: "https://example.com/screenshot/foo/bar.png" }, env, ctx)

    expect(env.SCREENSHOTS.get).toHaveBeenCalledWith("example.com/foo/bar.png")
    expect(await response.text()).toBe("cached-bytes")
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(response.headers.get("Cache-Control")).toContain("public")
    expect(env.BROWSER.get).not.toHaveBeenCalled()
  })

  it("serves a cached PDF with the correct content type", async () => {
    env.SCREENSHOTS.get.mockResolvedValue({
      body: "cached-pdf-bytes",
      uploaded: new Date().toISOString(),
    })

    const response = await worker.fetch({ url: "https://example.com/screenshot/foo/bar.pdf" }, env, ctx)

    expect(response.headers.get("Content-Type")).toBe("application/pdf")
  })

  it("serves a cached video with the correct content type", async () => {
    env.SCREENSHOTS.get.mockResolvedValue({
      body: "cached-mp4-bytes",
      uploaded: new Date().toISOString(),
    })

    const response = await worker.fetch({ url: "https://example.com/screenshot/foo/bar.mp4" }, env, ctx)

    expect(response.headers.get("Content-Type")).toBe("video/mp4")
  })

  it("defaults to png content type when the cached entry has no format", async () => {
    env.SCREENSHOTS.get.mockResolvedValue({
      body: "cached-bytes",
      uploaded: new Date().toISOString(),
    })

    const response = await worker.fetch({ url: "https://example.com/screenshots/foo/bar" }, env, ctx)

    expect(response.headers.get("Content-Type")).toBe("image/png")
  })

  it("does not trigger a background refresh when the cached entry has no upload time", async () => {
    env.SCREENSHOTS.get.mockResolvedValue({ body: "cached-bytes", uploaded: null })

    await worker.fetch({ url: "https://example.com/screenshot/foo/bar.png" }, env, ctx)

    expect(env.BROWSER.get).not.toHaveBeenCalled()
  })

  it("serves the stale cached copy while refreshing it in the background", async () => {
    const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    env.SCREENSHOTS.get.mockResolvedValue({ body: "stale-bytes", uploaded: staleDate })
    env.stub.fetch.mockResolvedValue(new Response("fresh-bytes", { status: 200 }))

    const response = await worker.fetch({ url: "https://example.com/screenshot/foo/bar.png" }, env, ctx)

    expect(await response.text()).toBe("stale-bytes")
    expect(env.stub.fetch).toHaveBeenCalledWith("https://example.com/screenshot/foo/bar.png")
    expect(await ctx.waitUntil.mock.calls[0][0]).toBeInstanceOf(Response)
  })

  it("fetches and serves a new screenshot on a cache miss", async () => {
    env.stub.fetch.mockResolvedValue(new Response("brand-new-bytes", { status: 200 }))

    const response = await worker.fetch({ url: "https://example.com/screenshot/1024x768/foo/bar.png" }, env, ctx)

    expect(env.SCREENSHOTS.get).toHaveBeenCalledWith("example.com/foo/bar-1024x768.png")
    expect(env.stub.fetch).toHaveBeenCalledWith("https://example.com/screenshot/1024x768/foo/bar.png")
    expect(await response.text()).toBe("brand-new-bytes")
    expect(env.SCREENSHOTS.put).not.toHaveBeenCalled()
  })

  it("builds the cache key from scale, format, and query string", async () => {
    env.stub.fetch.mockResolvedValue(new Response("bytes", { status: 200 }))

    await worker.fetch({ url: "https://example.com/screenshot/foo/bar.pdf?dark=on" }, env, ctx)

    expect(env.SCREENSHOTS.get).toHaveBeenCalledWith("example.com/foo/bar.pdf?dark=on")
  })

  it("includes duration in the cache key", async () => {
    env.stub.fetch.mockResolvedValue(new Response("bytes", { status: 200 }))

    await worker.fetch({ url: "https://example.com/screenshot/1200x630/20s/foo/bar@2x.mp4" }, env, ctx)

    expect(env.SCREENSHOTS.get).toHaveBeenCalledWith("example.com/foo/bar-1200x630-20s@2x.mp4")
  })

  it("includes scale in the cache key", async () => {
    env.stub.fetch.mockResolvedValue(new Response("bytes", { status: 200 }))

    await worker.fetch({ url: "https://example.com/screenshot/foo/bar@2x.png" }, env, ctx)

    expect(env.SCREENSHOTS.get).toHaveBeenCalledWith("example.com/foo/bar@2x.png")
  })

  it("passes a failed cache-miss fetch through", async () => {
    env.stub.fetch.mockResolvedValue(new Response("boom", { status: 502 }))

    const response = await worker.fetch({ url: "https://example.com/screenshot/foo/bar.png" }, env, ctx)

    expect(response.status).toBe(502)
  })
})

describe("Browser", () => {
  let env
  let state
  let browser
  let instance

  beforeEach(() => {
    env = createEnv()
    state = { storage: createStorage() }
    instance = createMockBrowserInstance()
    puppeteer.launch.mockReset()
    puppeteer.launch.mockResolvedValue(instance)
    browser = new Browser(state, env)
  })

  it("saves what it makes to R2 under the cache key", async () => {
    await browser.fetch({ url: "https://example.com/screenshot/1200x630/foo/bar.png?dark=on" })

    expect(env.SCREENSHOTS.put).toHaveBeenCalledWith("example.com/foo/bar-1200x630.png?dark=on", "png-bytes")
  })

  it("still serves a screenshot it could not save", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    env.SCREENSHOTS.put.mockRejectedValue(new Error("R2 down"))

    const response = await browser.fetch({ url: "https://example.com/screenshot/foo/bar" })

    expect(await response.text()).toBe("png-bytes")
    expect(error).toHaveBeenCalledWith("Failed to save example.com/foo/bar.png: R2 down")
    error.mockRestore()
  })

  it("shares one recording between requests for the same screenshot", async () => {
    const url = "https://example.com/screenshot/foo/bar"

    const responses = await Promise.all([browser.fetch({ url }), browser.fetch({ url })])

    expect(instance.page.screenshot).toHaveBeenCalledTimes(1)
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(["png-bytes", "png-bytes"])

    await browser.fetch({ url })

    expect(instance.page.screenshot).toHaveBeenCalledTimes(2)
  })

  it("launches a browser and takes a screenshot with default dimensions", async () => {
    const response = await browser.fetch({
      url: "https://example.com/screenshot/foo/bar",
    })

    expect(puppeteer.launch).toHaveBeenCalledWith(env.MYBROWSER, { keep_alive: 600000 })
    expect(instance.page.setViewport).toHaveBeenCalledWith({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
    })
    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/foo/bar", { waitUntil: "networkidle0" })
    expect(instance.page.screenshot).toHaveBeenCalledWith({
      clip: { width: 1280, height: 720, x: 0, y: 0 },
    })
    expect(instance.page.pdf).not.toHaveBeenCalled()
    expect(instance.page.setExtraHTTPHeaders).not.toHaveBeenCalled()
    expect(response.headers.get("Content-Type")).toBe("image/png")
    expect(await response.text()).toBe("png-bytes")
    expect(state.storage.setAlarm).toHaveBeenCalled()
    expect(browser.pending).toBe(0)
  })

  it("passes error pages through without screenshotting them", async () => {
    instance.page.goto.mockResolvedValue({ ok: () => false, status: () => 404 })

    const response = await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })

    expect(response.status).toBe(404)
    expect(await response.text()).toBe("")
    expect(instance.page.screenshot).not.toHaveBeenCalled()
    expect(instance.context.close).toHaveBeenCalled()
    expect(state.storage.setAlarm).toHaveBeenCalled()
  })

  it("returns a 500 and cleans up when the page fails to load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    instance.page.goto.mockRejectedValue(new Error("timeout"))
    instance.context.close.mockRejectedValue(new Error("already closed"))

    const response = await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })

    expect(response.status).toBe(500)
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.text()).toBe("Failed to render page: timeout")
    expect(error).toHaveBeenCalledWith("Failed to render https://example.com/foo/bar: timeout")
    expect(instance.context.close).toHaveBeenCalled()
    expect(env.SCREENSHOTS.put).not.toHaveBeenCalled()
    expect(state.storage.setAlarm).toHaveBeenCalled()
    expect(browser.pending).toBe(0)
    error.mockRestore()
  })

  it("generates a PDF with dimensions and scale parsed from the URL", async () => {
    const response = await browser.fetch({
      url: "https://example.com/screenshot/1024x768/foo/bar@2x.pdf?dark=on",
    })

    expect(instance.page.setViewport).toHaveBeenCalledWith({
      width: 1024,
      height: 768,
      deviceScaleFactor: 2,
    })
    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/foo/bar?dark=on", { waitUntil: "networkidle0" })
    expect(instance.page.pdf).toHaveBeenCalledWith({
      format: "A4",
      margin: { top: 20, right: 40, bottom: 20, left: 40 },
    })
    expect(instance.page.screenshot).not.toHaveBeenCalled()
    expect(response.headers.get("Content-Type")).toBe("application/pdf")
    expect(await response.text()).toBe("pdf-bytes")
  })

  it("records an MP4 at the scaled dimensions for the requested duration", async () => {
    vi.mocked(record).mockResolvedValue("mp4-bytes")

    const response = await browser.fetch({
      url: "https://example.com/screenshot/1200x630/20s/foo/bar@2x.mp4",
    })

    expect(prepare).toHaveBeenCalledWith(instance.page)
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(instance.page.goto.mock.invocationCallOrder[0])
    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/foo/bar", { waitUntil: "networkidle0" })
    expect(record).toHaveBeenCalledWith(instance.page, { format: "mp4", width: 2400, height: 1260, duration: 20 })
    expect(instance.page.screenshot).not.toHaveBeenCalled()
    expect(response.headers.get("Content-Type")).toBe("video/mp4")
    expect(await response.text()).toBe("mp4-bytes")
  })

  it("records a GIF for five seconds by default", async () => {
    vi.mocked(record).mockResolvedValue("gif-bytes")

    const response = await browser.fetch({ url: "https://example.com/screenshot/foo/bar.gif" })

    expect(record).toHaveBeenCalledWith(instance.page, { format: "gif", width: 1280, height: 720, duration: 5 })
    expect(response.headers.get("Content-Type")).toBe("image/gif")
  })

  it("records an animated WebP", async () => {
    vi.mocked(record).mockResolvedValue("webp-bytes")

    const response = await browser.fetch({ url: "https://example.com/screenshot/foo/bar.webp" })

    expect(record).toHaveBeenCalledWith(instance.page, { format: "webp", width: 1280, height: 720, duration: 5 })
    expect(response.headers.get("Content-Type")).toBe("image/webp")
  })

  it("treats durations over 30 seconds as part of the path", async () => {
    await browser.fetch({ url: "https://example.com/screenshot/60s/foo/bar.mp4" })

    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/60s/foo/bar", { waitUntil: "networkidle0" })
    expect(record).toHaveBeenCalledWith(instance.page, expect.objectContaining({ duration: 5 }))
  })

  it("merges the environment's QUERY_PARAMS with the URL's own query string", async () => {
    env.QUERY_PARAMS = "?utm=test"

    await browser.fetch({
      url: "https://example.com/screenshot/foo/bar.png?dark=on",
    })

    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/foo/bar?dark=on&utm=test", { waitUntil: "networkidle0" })
  })

  it("uses only the environment's QUERY_PARAMS when the URL has no query string", async () => {
    env.QUERY_PARAMS = "?utm=test"

    await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })

    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/foo/bar?utm=test", { waitUntil: "networkidle0" })
  })

  it("screenshots the homepage for /home, keeping the query string", async () => {
    env.QUERY_PARAMS = "?utm=test"

    await browser.fetch({ url: "https://example.com/screenshot/home.png?dark=on" })

    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/?dark=on&utm=test", { waitUntil: "networkidle0" })
  })

  it("does not rewrite nested home paths", async () => {
    await browser.fetch({ url: "https://example.com/screenshot/foo/home.png" })

    expect(instance.page.goto).toHaveBeenCalledWith("https://example.com/foo/home", { waitUntil: "networkidle0" })
  })

  it("sends CF Access headers when configured", async () => {
    env.CF_ACCESS_CLIENT_ID = "client-id"
    env.CF_ACCESS_CLIENT_SECRET = "client-secret"

    await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })

    expect(instance.page.setExtraHTTPHeaders).toHaveBeenCalledWith({
      "CF-Access-Client-Id": "client-id",
      "CF-Access-Client-Secret": "client-secret",
    })
  })

  it("reuses an already-connected browser instead of relaunching", async () => {
    await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })
    await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })

    expect(puppeteer.launch).toHaveBeenCalledTimes(1)
    expect(instance.isConnected).toHaveBeenCalled()
  })

  it("relaunches when the existing browser is no longer connected", async () => {
    await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })
    instance.isConnected.mockReturnValue(false)

    await browser.fetch({ url: "https://example.com/screenshot/foo/bar.png" })

    expect(puppeteer.launch).toHaveBeenCalledTimes(2)
  })

  it("returns a 500 when launching the browser fails", async () => {
    puppeteer.launch.mockRejectedValue(new Error("boom"))

    const response = await browser.fetch({
      url: "https://example.com/screenshot/foo/bar.png",
    })

    expect(response.status).toBe(500)
    expect(await response.text()).toBe("Failed to launch browser: boom")
  })

  it("returns a 429 when the launch failure message mentions 429", async () => {
    puppeteer.launch.mockRejectedValue(new Error("429 Too Many Requests"))

    const response = await browser.fetch({
      url: "https://example.com/screenshot/foo/bar.png",
    })

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    expect(await response.text()).toContain("rate limit exceeded")
  })

  it("returns a 429 when the launch failure message mentions a rate limit", async () => {
    puppeteer.launch.mockRejectedValue(new Error("Rate limit hit, slow down"))

    const response = await browser.fetch({
      url: "https://example.com/screenshot/foo/bar.png",
    })

    expect(response.status).toBe(429)
  })

  it("treats a missing error message as a generic failure", async () => {
    const response = await browser.error("Failed to launch browser")

    expect(response.status).toBe(500)
    expect(response.headers.get("Retry-After")).toBeNull()
    expect(await response.text()).toBe("Failed to launch browser: undefined")
  })
})

describe("Browser.alarm", () => {
  let browser

  beforeEach(() => {
    const env = createEnv()
    const state = { storage: createStorage() }
    browser = new Browser(state, env)
  })

  it("leaves the browser open while a screenshot is in progress", async () => {
    browser.pending = 1
    browser.browser = { close: vi.fn().mockResolvedValue(undefined) }

    await browser.alarm()

    expect(browser.browser.close).not.toHaveBeenCalled()
  })

  it("does nothing without an active browser", async () => {
    await browser.alarm()

    expect(browser.browser).toBeUndefined()
  })

  it("closes the browser once idle", async () => {
    browser.browser = { close: vi.fn().mockResolvedValue(undefined) }
    const closeMock = browser.browser.close

    await browser.alarm()

    expect(closeMock).toHaveBeenCalled()
    expect(browser.browser).toBeNull()
  })

  it("swallows errors when closing the browser during cleanup", async () => {
    browser.browser = { close: vi.fn().mockRejectedValue(new Error("close failed")) }

    await expect(browser.alarm()).resolves.toBeUndefined()
    expect(browser.browser).toBeNull()
  })
})
