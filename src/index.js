import puppeteer from "@cloudflare/puppeteer"
import { regexMerge } from "./support"
import { prepare, record } from "./video"

const BROWSER_CACHE_TTL = 7 * 24 * 60 * 60
const BROWSER_IDLE_LIMIT = 10 * 60 * 1000
const BROWSER_KEEP_ALIVE = 5
const CONTENT_TYPES = { gif: "image/gif", mp4: "video/mp4", pdf: "application/pdf", png: "image/png", webp: "image/webp" }
const DEFAULT_DURATION = 5
const DEFAULT_FORMAT = "png"
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 720
const DEFAULT_SCALE = 1
const STORAGE_TTL = 7 * 24 * 60 * 60
const URL_PATTERN = regexMerge(
  /^(?<base>https:\/\/[\w./]+)\/screenshots?/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?:\/(?<duration>[1-9]|[12][0-9]|30)s)?/,
  /(?<path>\/.*?)/,
  /(?:@(?<scale>[2-4])x)?/,
  /(?:\.(?<format>(gif|mp4|pdf|png|webp)))?/,
  /(?<query>\?.*)?$/,
)
const VIDEO_FORMATS = ["gif", "mp4", "webp"]

const browserFor = (env) => env.BROWSER.get(env.BROWSER.idFromName("browser"))

function cacheKey({ base, duration, format, path, query, width, height, scale }) {
  const { hostname } = new URL(base)

  return [
    hostname,
    path,
    width && height ? `-${width}x${height}` : "",
    duration ? `-${duration}s` : "",
    scale ? `@${scale}x` : "",
    `.${format || DEFAULT_FORMAT}`,
    query,
  ]
    .filter((x) => x)
    .join("")
}

async function serveScreenshot(body, format) {
  return new Response(body, {
    headers: {
      "Content-Type": CONTENT_TYPES[format || DEFAULT_FORMAT],
      "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const settings = request.url.match(URL_PATTERN).groups

    // Nothing to screenshot at the root
    if (settings.path === "/") {
      return new Response(null, { status: 404 })
    }

    // Check R2 bucket for existing screenshot
    const existing = await env.SCREENSHOTS.get(cacheKey(settings))

    if (existing) {
      const uploaded = existing.uploaded ? new Date(existing.uploaded).getTime() : null

      // If stale, trigger background refresh for next visitor
      if (uploaded && Date.now() - uploaded > STORAGE_TTL * 1000) {
        ctx.waitUntil(browserFor(env).fetch(request.url))
      }

      return await serveScreenshot(existing.body, settings.format)
    }

    // No existing screenshot, generate a new one
    return await browserFor(env).fetch(request.url)
  },
}

export class Browser {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.pending = 0
    this.inflight = new Map()
    this.storage = this.state.storage
  }

  async fetch(request) {
    const settings = request.url.match(URL_PATTERN).groups
    const key = cacheKey(settings)

    if (!this.inflight.has(key)) {
      this.inflight.set(
        key,
        this.generate(settings, key).finally(() => this.inflight.delete(key)),
      )
    }

    return (await this.inflight.get(key)).clone()
  }

  async generate(settings, key) {
    const { base, duration, format, path, width, height, scale } = {
      ...settings,
      duration: parseInt(settings.duration ?? DEFAULT_DURATION, 10),
      format: settings.format ?? DEFAULT_FORMAT,
      width: parseInt(settings.width ?? DEFAULT_WIDTH, 10),
      height: parseInt(settings.height ?? DEFAULT_HEIGHT, 10),
      scale: parseInt(settings.scale ?? DEFAULT_SCALE, 10),
    }

    const params = [
      ...(settings.query ? settings.query.replace(/^\?/, "").split("&") : []),
      ...(this.env.QUERY_PARAMS ? this.env.QUERY_PARAMS.replace(/^\?/, "").split("&") : []),
    ]

    const query = params.length ? `?${params.join("&")}` : null

    const url = [base, path === "/home" ? "/" : path, query].filter((x) => x).join("")

    if (!this.browser?.isConnected()) {
      try {
        this.browser = await puppeteer.launch(this.env.MYBROWSER, { keep_alive: BROWSER_IDLE_LIMIT })
      } catch (e) {
        return this.error("Failed to launch browser", e.message)
      }
    }

    this.pending++

    let context
    let screenshot

    try {
      context = await this.browser.createBrowserContext()

      const page = await context.newPage()

      if (this.env.CF_ACCESS_CLIENT_ID && this.env.CF_ACCESS_CLIENT_SECRET) {
        await page.setExtraHTTPHeaders({
          "CF-Access-Client-Id": this.env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": this.env.CF_ACCESS_CLIENT_SECRET,
        })
      }

      await page.setViewport({ width, height, deviceScaleFactor: scale })

      if (VIDEO_FORMATS.includes(format)) {
        await prepare(page)
      }

      const response = await page.goto(url, { waitUntil: "networkidle0" })

      // Pass error pages through instead of screenshotting them
      if (!response.ok()) {
        return new Response(null, { status: response.status() })
      }

      if (VIDEO_FORMATS.includes(format)) {
        screenshot = await record(page, { format, width: width * scale, height: height * scale, duration })
      } else if (format === "pdf") {
        screenshot = await page.pdf({
          format: "A4",
          margin: { top: 20, right: 40, bottom: 20, left: 40 },
        })
      } else {
        screenshot = await page.screenshot({
          clip: { width, height, x: 0, y: 0 },
        })
      }
    } catch (e) {
      console.error(`Failed to render ${url}: ${e.message}`)

      return this.error("Failed to render page", e.message)
    } finally {
      await context?.close().catch(() => {})

      // Close the browser once it has been idle for BROWSER_KEEP_ALIVE seconds
      this.pending--
      await this.storage.setAlarm(Date.now() + BROWSER_KEEP_ALIVE * 1000)
    }

    try {
      await this.env.SCREENSHOTS.put(key, screenshot)
    } catch (e) {
      console.error(`Failed to save ${key}: ${e.message}`)
    }

    return new Response(screenshot, {
      headers: {
        "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
        "Content-Type": CONTENT_TYPES[format],
        Expires: new Date(Date.now() + BROWSER_CACHE_TTL * 1000).toUTCString(),
      },
    })
  }

  async alarm() {
    // A screenshot in progress will schedule another alarm when it finishes
    if (this.pending === 0 && this.browser) {
      try {
        await this.browser.close()
      } catch (_e) {
        // Ignore errors when closing
      }
      this.browser = null
    }
  }

  error(reason, message) {
    const isRateLimit = message?.includes("429") || message?.includes("Rate limit")

    return new Response(isRateLimit ? "Browser Rendering API rate limit exceeded. Please try again later." : `${reason}: ${message}`, {
      status: isRateLimit ? 429 : 500,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain",
        ...(isRateLimit ? { "Retry-After": "60" } : {}),
      },
    })
  }
}
