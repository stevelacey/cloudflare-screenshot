import puppeteer from "@cloudflare/puppeteer"
import { regexMerge } from "./support"

const BROWSER_CACHE_TTL = 7 * 24 * 60 * 60
const BROWSER_KEEP_ALIVE = 60
const DEFAULT_FORMAT = "png"
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 720
const DEFAULT_SCALE = 1
const STORAGE_TTL = 7 * 24 * 60 * 60
const URL_PATTERN = regexMerge(
  /^(?<base>https:\/\/[\w\.\/]+)\/screenshots?/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?<path>\/.*?)/,
  /(?:@(?<scale>[2-4])x)?/,
  /(?:\.(?<format>(pdf|png)))?/,
  /(?<query>\?.*)?$/,
)

async function fetchScreenshot(request, env, key, ctx) {
  const browser = env.BROWSER.get(env.BROWSER.idFromName("browser"))

  const response = await browser.fetch(request.url)

  if (response.ok) {
    ctx.waitUntil(
      response.clone().arrayBuffer().then(async (buffer) => {
        await env.SCREENSHOTS.put(key, buffer)
      })
    )
  }

  return response
}

async function serveScreenshot(body, format) {
  const contentType = (format || "png") === "pdf" ? "application/pdf" : `image/${format || "png"}`

  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
    },
  })
}

export default {
  async fetch(request, env, ctx) {
    const match = request.url.match(URL_PATTERN)
    const { base, path, query, format } = match.groups

    const hostname = new URL(base).hostname
    const key = `${hostname}${path}${query || ""}`

    // Check R2 bucket for existing screenshot
    const existing = await env.SCREENSHOTS.get(key)

    if (existing) {
      const uploaded = existing.uploaded ? new Date(existing.uploaded).getTime() : null

      // If stale, trigger background refresh for next visitor
      if (uploaded && (Date.now() - uploaded > STORAGE_TTL * 1000)) {
        fetchScreenshot(request, env, key, ctx)
      }

      return await serveScreenshot(existing.body, format)
    }

    // No existing screenshot, generate a new one
    return await fetchScreenshot(request, env, key, ctx)
  }
}

export class Browser {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.keptAliveInSeconds = 0
    this.storage = this.state.storage
  }

  async fetch(request) {
    const settings = request.url.match(URL_PATTERN).groups

    const { base, format, path, width, height, scale } = {
      ...settings,
      format: settings.format ?? DEFAULT_FORMAT,
      width: parseInt(settings.width ?? DEFAULT_WIDTH),
      height: parseInt(settings.height ?? DEFAULT_HEIGHT),
      scale: parseInt(settings.scale ?? DEFAULT_SCALE),
    }

    const params = [
      ...settings.query ? settings.query.replace(/^\?/, "").split("&") : [],
      ...this.env.QUERY_PARAMS ? this.env.QUERY_PARAMS.replace(/^\?/, "").split("&") : [],
    ]

    const query = params ? `?${params.join("&")}` : null

    const url = [base, path, query].filter(x => x).join("")

    if (!this.browser || !this.browser.isConnected()) {
      try {
        // Launch browser with keep_alive set to 10 minutes (600000ms)
        // This extends the timeout period and allows better session reuse
        this.browser = await puppeteer.launch(this.env.MYBROWSER, {
          keep_alive: 600000,
        })
      } catch (e) {
        return await this.error(e.message)
      }
    }

    this.keptAliveInSeconds = 0

    const context = await this.browser.createIncognitoBrowserContext()

    try {
      const page = await context.newPage()

      try {
        if (this.env.CF_ACCESS_CLIENT_ID && this.env.CF_ACCESS_CLIENT_SECRET) {
          await page.setExtraHTTPHeaders({
            "CF-Access-Client-Id": this.env.CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": this.env.CF_ACCESS_CLIENT_SECRET,
          })
        }

        await page.setViewport({ width, height, deviceScaleFactor: scale })

        await page.goto(url, { waitUntil: "networkidle0" })

        const screenshot = await (format === "pdf" ? page.pdf({
          format: "A4",
          margin: { top: 20, right: 40, bottom: 20, left: 40 },
        }) : page.screenshot({
          clip: { width, height, x: 0, y: 0 },
        }))

        // Reset keptAlive timer and reschedule alarm
        this.keptAliveInSeconds = 0
        await this.storage.setAlarm(Date.now() + 10 * 1000)

        return new Response(screenshot, {
          headers: {
            "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
            "Content-Type": format === "pdf" ? "application/pdf" : `image/${format}`,
            "Expires": new Date(Date.now() + BROWSER_CACHE_TTL * 1000).toUTCString(),
          },
        })
      } catch (e) {
        return await this.error(e.message)
      } finally {
        await page.close().catch(() => { })
      }
    } finally {
      await context.close().catch(() => { })
    }
  }

  async alarm() {
    this.keptAliveInSeconds += 10

    if (this.keptAliveInSeconds < BROWSER_KEEP_ALIVE) {
      await this.storage.setAlarm(Date.now() + 10 * 1000)
    } else {
      if (this.browser) {
        try {
          await this.browser.close()
        } catch (e) {
          // Ignore errors when closing
        }
        this.browser = null
      }
    }
  }

  async error(message) {
    const isRateLimit = message?.includes("429") || message?.includes("Rate limit")

    return new Response(
      isRateLimit
        ? "Browser Rendering API rate limit exceeded. Please try again later."
        : `Failed to launch browser: ${message}`,
      {
        status: isRateLimit ? 429 : 500,
        headers: { "Content-Type": "text/plain" },
      }
    )
  }
}
