import puppeteer from "@cloudflare/puppeteer"
import { regexMerge } from "./support"

const pattern = regexMerge(
  /^(?<base>https:\/\/[\w\.\/]+)\/screenshots?/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?<path>\/.*?)/,
  /(?:@(?<scale>[2-4])x)?/,
  /(?:\.(?<format>(pdf|png)))?/,
  /(?<query>\?.*)?$/,
)

export default {
  async fetch(request, env, ctx) {
    const match = request.url.match(pattern)
    const { base, path, query, format } = match.groups

    const hostname = new URL(base).hostname
    const key = `${hostname}${path}${query || ""}`

    // Check R2 bucket for existing screenshot
    const existing = await env.SCREENSHOTS.get(key)

    if (existing) {
      const contentType = (format || "png") === "pdf" ? "application/pdf" : `image/${format || "png"}`

      return new Response(existing.body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
        },
      })
    }

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
}

const defaults = {
  format: "png",
  width: 1280,
  height: 720,
  maxage: 60 * 60 * 24 * 7,
  scale: 1,
}

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60

export class Browser {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.keptAliveInSeconds = 0
    this.storage = this.state.storage
  }

  async fetch(request) {
    const settings = request.url.match(pattern).groups

    const { base, format, path, width, height, maxage, scale } = {
      ...defaults,
      ...settings,
      format: settings.format ?? defaults.format,
      width: parseInt(settings.width ?? defaults.width),
      height: parseInt(settings.height ?? defaults.height),
      scale: parseInt(settings.scale ?? defaults.scale),
    }

    const params = [
      ...settings.query ? settings.query.replace(/^\?/, "").split("&") : [],
      ...this.env.QUERY_PARAMS ? this.env.QUERY_PARAMS.replace(/^\?/, "").split("&") : [],
    ]

    const query = params ? `?${params.join("&")}` : null

    const url = [base, path, query].filter(x => x).join("")

    // Check if we need to launch a new browser
    if (!this.browser) {
      try {
        this.browser = await puppeteer.launch(this.env.MYBROWSER)
      } catch (e) {
        const isRateLimit = e.message?.includes("429") || e.message?.includes("Rate limit")
        return new Response(
          isRateLimit
            ? "Browser Rendering API rate limit exceeded. Please try again later."
            : `Failed to launch browser: ${e.message}`,
          {
            status: isRateLimit ? 429 : 500,
            headers: { "Content-Type": "text/plain" },
          }
        )
      }
    } else {
      // Check if browser is still connected
      try {
        if (!this.browser.isConnected()) {
          this.browser = await puppeteer.launch(this.env.MYBROWSER)
        }
      } catch (e) {
        // Browser in bad state, try to launch a new one
        try {
          this.browser = await puppeteer.launch(this.env.MYBROWSER)
        } catch (e2) {
          const isRateLimit = e2.message?.includes("429") || e2.message?.includes("Rate limit")
          return new Response(
            isRateLimit
              ? "Browser Rendering API rate limit exceeded. Please try again later."
              : `Failed to launch browser: ${e2.message}`,
            {
              status: isRateLimit ? 429 : 500,
              headers: { "Content-Type": "text/plain" },
            }
          )
        }
      }
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0

    const context = await this.browser.createIncognitoBrowserContext()

    const page = await context.newPage()

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

    await page.close()

    await context.close()

    // Reset keptAlive timer and reschedule alarm
    this.keptAliveInSeconds = 0
    await this.storage.setAlarm(Date.now() + 10 * 1000)

    return new Response(screenshot, {
      headers: {
        "Cache-Control": `public, max-age=${maxage}`,
        "Content-Type": format === "pdf" ? "application/pdf" : `image/${format}`,
        "Expires": new Date(Date.now() + maxage * 1000).toUTCString(),
      },
    })
  }

  async alarm() {
    this.keptAliveInSeconds += 10

    if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
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
}
