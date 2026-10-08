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
const OPTIONS = { duration: /^([1-9]|[12][0-9]|30)s$/, scroll: /^([\w-]+(?:;[\w-]+){0,19})$/ }
const STORAGE_TTL = 7 * 24 * 60 * 60
const URL_PATTERN = regexMerge(
  /^(?<base>https:\/\/[\w./]+)\/screenshots?/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?:\/(?<options>[a-z]+=[\w.;-]+(?:,[a-z]+=[\w.;-]+)*))?/,
  /(?<path>\/.*?)/,
  /(?:@(?:(?<scale>[2-4])x|(?<resolution>240|360|480|720|1080|1440|2160)p|(?<uhd>4k)))?/,
  /(?:\.(?<format>(gif|mp4|pdf|png|webp)))?/,
  /(?<query>\?.*)?$/,
)
const VIDEO_FORMATS = ["gif", "mp4", "webp"]

const browserFor = (env) => env.BROWSER.get(env.BROWSER.idFromName("browser"))

function outputSize({ resolution, scale, uhd }) {
  // 4k is another name for 2160p, so both share one file
  if (uhd || resolution === "2160") {
    return "@4k"
  }

  if (resolution) {
    return `@${resolution}p`
  }

  return scale ? `@${scale}x` : ""
}

// The URL's parts, with options like duration=8s,scroll=2026;2025, or null when any option is unknown or invalid
function settingsFor(url) {
  const settings = { ...url.match(URL_PATTERN).groups }

  for (const option of settings.options?.split(",") ?? []) {
    const [name, value] = option.split("=")
    const match = Object.hasOwn(OPTIONS, name) && value.match(OPTIONS[name])

    if (!match) {
      return null
    }

    settings[name] = match[1]
  }

  return settings
}

function cacheKey({ base, duration, format, path, query, resolution, scroll, width, height, scale, uhd }) {
  const { hostname } = new URL(base)

  return [
    hostname,
    path,
    width && height ? `-${width}x${height}` : "",
    duration ? `-${duration}s` : "",
    scroll ? `-to-${scroll}` : "",
    outputSize({ resolution, scale, uhd }),
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
    const settings = settingsFor(request.url)

    // Nothing to screenshot at the root, or with options that don't exist
    if (!settings || settings.path === "/") {
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
    this.recordings = Promise.resolve()
    this.storage = this.state.storage
  }

  async fetch(request) {
    const settings = settingsFor(request.url)
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
    const { base, duration, format, path, resolution, scroll, width, height, scale } = {
      ...settings,
      scroll: settings.scroll?.split(";"),
      duration: parseInt(settings.duration ?? DEFAULT_DURATION, 10),
      format: settings.format ?? DEFAULT_FORMAT,
      width: parseInt(settings.width ?? DEFAULT_WIDTH, 10),
      height: parseInt(settings.height ?? DEFAULT_HEIGHT, 10),
      scale: parseInt(settings.scale ?? DEFAULT_SCALE, 10),
      resolution: settings.uhd ? 2160 : settings.resolution && parseInt(settings.resolution, 10),
    }

    // A resolution sets the output height, keeping the page laid out at its own size. Larger output renders at a higher pixel
    // density; smaller output has Chrome draw each frame at that size, which keeps text crisper than shrinking it afterwards
    // Sides round to even numbers, which video needs and which gives the standard sizes, like 854x480 for 480p
    const even = (size) => Math.round(size / 2) * 2
    const output = resolution ? { width: even((width * resolution) / height), height: resolution } : { width: width * scale, height: height * scale }
    // Chrome captures at one scale, so it takes the larger of the two, with any pixel over cropped when encoding
    const zoom = Math.max(output.width / width, output.height / height)
    const shrink = Math.min(zoom, 1)

    // Other sites are reached by naming them first when listed in EXTERNAL_DOMAINS
    const [, host, rest = "/"] = path.match(/^\/([^/]*)(\/.*)?$/)
    const domains = (this.env.EXTERNAL_DOMAINS ?? "")
      .split(",")
      .map((domain) => domain.trim())
      .filter((domain) => domain)
    const external = domains.includes(host)

    const params = [
      ...(settings.query ? settings.query.replace(/^\?/, "").split("&") : []),
      ...(this.env.QUERY_PARAMS && !external ? this.env.QUERY_PARAMS.replace(/^\?/, "").split("&") : []),
    ]

    const query = params.length ? `?${params.join("&")}` : null

    let url = [base, path === "/home" ? "/" : path, query].filter((x) => x).join("")

    if (external) {
      url = `https://${host}${rest}${query ?? ""}`
    }

    try {
      await this.connect()
    } catch (e) {
      return this.error("Failed to launch browser", e.message)
    }

    this.pending++

    let screenshot

    try {
      const options = { duration, external, format, height, output, scroll, shrink, width, zoom }

      // Recordings take minutes and work the browser hard enough that several at once crash it, so they take turns
      screenshot = await (VIDEO_FORMATS.includes(format) ? this.queue(() => this.attempt(url, options)) : this.attempt(url, options))

      // Pass error pages through instead of screenshotting them
      if (screenshot instanceof Response) {
        return screenshot
      }
    } catch (e) {
      console.error(`Failed to render ${url}: ${e.message}`)

      return this.error("Failed to render page", e.message)
    } finally {
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

  // Requests that arrive while the browser is launching share the launch
  async connect() {
    if (!this.browser?.isConnected()) {
      this.launching ??= puppeteer.launch(this.env.MYBROWSER, { keep_alive: BROWSER_IDLE_LIMIT }).finally(() => {
        this.launching = null
      })
      this.browser = await this.launching
    }
  }

  queue(task) {
    const turn = this.recordings.then(task)

    this.recordings = turn.catch(() => {})

    return turn
  }

  // Tries once more in a new browser when the browser dies, which takes everything in it down too
  async attempt(url, options) {
    await this.connect()

    try {
      return await this.render(url, options)
    } catch (e) {
      if (this.browser.isConnected()) {
        throw e
      }

      await this.connect()

      return await this.render(url, options)
    }
  }

  // Each attempt gets a fresh context, so nothing from a failed one carries over
  async render(url, { duration, external, format, height, output, scroll, shrink, width, zoom }) {
    const context = await this.browser.createBrowserContext()

    try {
      const page = await context.newPage()

      if (!external && this.env.CF_ACCESS_CLIENT_ID && this.env.CF_ACCESS_CLIENT_SECRET) {
        await page.setExtraHTTPHeaders({
          "CF-Access-Client-Id": this.env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": this.env.CF_ACCESS_CLIENT_SECRET,
        })
      }

      await page.setViewport({ width, height, deviceScaleFactor: Math.max(zoom, 1) })

      if (VIDEO_FORMATS.includes(format)) {
        await prepare(page)
      }

      const response = await page.goto(url, { waitUntil: "load" })

      if (!response.ok()) {
        return new Response(null, { status: response.status() })
      }

      // Wait for requests to finish rather than for Chrome to call the page idle, which a busy page like one drawing
      // WebGL without a GPU never reaches
      await page.waitForNetworkIdle()

      if (VIDEO_FORMATS.includes(format)) {
        return await record(page, { format, ...output, duration, scroll, clip: shrink < 1 ? { x: 0, y: 0, width, height, scale: shrink } : undefined })
      }

      if (format === "pdf") {
        return await page.pdf({
          format: "A4",
          margin: { top: 20, right: 40, bottom: 20, left: 40 },
        })
      }

      return await page.screenshot({
        clip: { width, height, x: 0, y: 0, scale: shrink },
      })
    } finally {
      await context.close().catch(() => {})
    }
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
