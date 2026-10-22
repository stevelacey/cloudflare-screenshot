import puppeteer from "@cloudflare/puppeteer"
import { regexMerge } from "./support"
import { prepare, record } from "./video"

const BROWSER_CACHE_TTL = 7 * 24 * 60 * 60
const BROWSER_IDLE_LIMIT = 10 * 60 * 1000
const BROWSER_KEEP_ALIVE = 5
const CONTENT_TYPES = { gif: "image/gif", jpg: "image/jpeg", mp4: "video/mp4", pdf: "application/pdf", png: "image/png", webp: "image/webp" }
const DEFAULT_DURATION = 5
const DEFAULT_FORMAT = "png"
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 720
const DEFAULT_QUALITY = 80
const DEFAULT_SCALE = 1
const ERROR_TTL = 5 * 60
// Old names for options, still understood
const ALIASES = { "color-scheme": "theme" }
const OPTIONS = {
  contrast: /^(more|less)$/,
  duration: /^([1-9]|[12][0-9]|30)s$/,
  effect: /^(crt|film|glitch|power|shine|vhs)$/,
  fps: /^([1-9]|[12][0-9]|30)$/,
  media: /^(print|screen)$/,
  motion: /^(reduce|no-preference)$/,
  quality: /^([1-9][0-9]?|100)$/,
  scroll: /^([\w-]+(?:;[\w-]+){0,19})$/,
  theme: /^(light|dark)$/,
}
const STORAGE_TTL = 7 * 24 * 60 * 60
const URL_PATTERN = regexMerge(
  /^(?<base>https:\/\/[\w./]+)\/screenshots?/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?:\/(?<options>[a-z-]+=[\w.;-]+(?:,[a-z-]+=[\w.;-]+)*))?/,
  /(?<path>\/.*?)/,
  /(?:@(?:(?<scale>[2-4])x|(?<resolution>240|360|480|720|1080|1440|2160)p|(?<uhd>4k)))?/,
  /(?:\.(?<format>(gif|jpg|mp4|pdf|png|webp)))?/,
  /(?<query>\?.*)?$/,
)
const VIDEO_FORMATS = ["gif", "mp4", "webp"]
const STILL_FORMATS = ["jpg", "pdf", "png"]
// Options only some formats use, which the others ignore rather than storing another copy that looks the same. GIFs have
// no quality setting, their size comes from the palette, PDFs are laid out for print while the rest are for screens, and
// stills reduce motion to catch the page settled while videos record it moving
const OPTION_FORMATS = {
  duration: VIDEO_FORMATS,
  effect: VIDEO_FORMATS,
  fps: VIDEO_FORMATS,
  "media=print": ["gif", "jpg", "mp4", "png", "webp"],
  "media=screen": ["pdf"],
  "motion=no-preference": STILL_FORMATS,
  "motion=reduce": VIDEO_FORMATS,
  quality: ["jpg", "mp4", "webp"],
  scroll: VIDEO_FORMATS,
}

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

// The URL's parts, with options like duration=8s,scroll=2026;2025, or an error when any option is unknown or invalid
function settingsFor(url) {
  const settings = { ...url.match(URL_PATTERN).groups }

  for (const option of settings.options?.split(",") ?? []) {
    const [given, value] = option.split("=")
    const name = Object.hasOwn(ALIASES, given) ? ALIASES[given] : given

    if (!Object.hasOwn(OPTIONS, name)) {
      return { error: `Unknown option: ${given}` }
    }

    const match = value.match(OPTIONS[name])

    if (!match) {
      return { error: `Invalid ${given}: ${value}` }
    }

    if ((OPTION_FORMATS[`${name}=${value}`] ?? OPTION_FORMATS[name])?.includes(settings.format ?? DEFAULT_FORMAT) ?? true) {
      settings[name] = match[1]
    }
  }

  return settings
}

function cacheKey({
  base,
  contrast,
  duration,
  effect,
  format,
  fps,
  media,
  motion,
  path,
  quality,
  query,
  resolution,
  scroll,
  theme,
  width,
  height,
  scale,
  uhd,
}) {
  const { hostname } = new URL(base)

  return [
    hostname,
    path,
    width && height ? `-${width}x${height}` : "",
    duration ? `-${duration}s` : "",
    fps ? `-${fps}fps` : "",
    quality ? `-q${quality}` : "",
    media ? `-${media}` : "",
    theme ? `-${theme}` : "",
    motion ? `-${motion}-motion` : "",
    contrast ? `-${contrast}-contrast` : "",
    scroll ? `-to-${scroll}` : "",
    effect ? `-${effect}` : "",
    outputSize({ resolution, scale, uhd }),
    `.${format || DEFAULT_FORMAT}`,
    query,
  ]
    .filter((x) => x)
    .join("")
}

async function serveScreenshot(request, existing, format) {
  const headers = {
    "Content-Type": CONTENT_TYPES[format || DEFAULT_FORMAT],
    "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
    ETag: existing.httpEtag,
    ...(existing.uploaded ? { "Last-Modified": new Date(existing.uploaded).toUTCString() } : {}),
  }

  // Browsers and crawlers that already have this copy only need telling it hasn't changed
  if (existing.httpEtag && request.headers?.get("If-None-Match") === existing.httpEtag) {
    return new Response(null, { status: 304, headers })
  }

  return new Response(existing.body, { headers })
}

// Deletes a stored screenshot so the next request makes a new one, for anyone holding PURGE_TOKEN
async function purge(request, env, settings) {
  const encoder = new TextEncoder()
  const given = encoder.encode(request.headers?.get("Authorization") ?? "")
  const expected = encoder.encode(`Bearer ${env.PURGE_TOKEN}`)

  if (!env.PURGE_TOKEN || given.byteLength !== expected.byteLength || !crypto.subtle.timingSafeEqual(given, expected)) {
    return new Response(null, { status: 401 })
  }

  await Promise.all([env.SCREENSHOTS.delete(cacheKey(settings)), caches.default.delete(request.url)])

  return new Response(null, { status: 204 })
}

export default {
  async fetch(request, env, ctx) {
    const settings = settingsFor(request.url)

    // Say what's wrong with options that don't exist or are out of range, rather than ignoring a typo
    if (settings.error) {
      return new Response(settings.error, { status: 400, headers: { "Content-Type": "text/plain" } })
    }

    // Nothing to screenshot at the root
    if (settings.path === "/") {
      return new Response(null, { status: 404 })
    }

    if (request.method === "DELETE") {
      return await purge(request, env, settings)
    }

    // Check R2 bucket for existing screenshot
    const existing = await env.SCREENSHOTS.get(cacheKey(settings))

    if (existing) {
      const uploaded = existing.uploaded ? new Date(existing.uploaded).getTime() : null

      // If stale, trigger background refresh for next visitor
      if (uploaded && Date.now() - uploaded > STORAGE_TTL * 1000) {
        ctx.waitUntil(browserFor(env).fetch(request.url))
      }

      return await serveScreenshot(request, existing, settings.format)
    }

    // A page that failed moments ago is likely to fail again, so that's remembered for a few minutes
    const failed = await caches.default.match(request.url)

    if (failed) {
      return failed
    }

    // No existing screenshot, generate a new one
    const response = await browserFor(env).fetch(request.url)

    // Rate limits pass on their own, so they're left out
    if (!response.ok && response.status !== 429) {
      const headers = new Headers(response.headers)

      headers.set("Cache-Control", `public, max-age=${ERROR_TTL}`)

      const remember = (body) => caches.default.put(request.url, new Response(body, { status: response.status, headers }))

      ctx.waitUntil(response.clone().arrayBuffer().then(remember))
    }

    return response
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
    const { base, contrast, duration, effect, format, fps, media, motion, path, quality, resolution, scroll, theme, width, height, scale } = {
      ...settings,
      scroll: settings.scroll?.split(";"),
      duration: parseInt(settings.duration ?? DEFAULT_DURATION, 10),
      fps: settings.fps && parseInt(settings.fps, 10),
      quality: settings.quality && parseInt(settings.quality, 10),
      format: settings.format ?? DEFAULT_FORMAT,
      motion: settings.motion ?? (STILL_FORMATS.includes(settings.format ?? DEFAULT_FORMAT) ? "reduce" : undefined),
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
      const options = { contrast, duration, effect, external, format, fps, height, media, motion, output, quality, scroll, shrink, theme, width, zoom }

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

    let saved

    try {
      saved = await this.env.SCREENSHOTS.put(key, screenshot)
    } catch (e) {
      console.error(`Failed to save ${key}: ${e.message}`)
    }

    return new Response(screenshot, {
      headers: {
        "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
        "Content-Type": CONTENT_TYPES[format],
        Expires: new Date(Date.now() + BROWSER_CACHE_TTL * 1000).toUTCString(),
        ...(saved ? { ETag: saved.httpEtag, "Last-Modified": saved.uploaded.toUTCString() } : {}),
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
  async render(url, { contrast, duration, effect, external, format, fps, height, media, motion, output, quality, scroll, shrink, theme, width, zoom }) {
    const context = await this.browser.createBrowserContext()

    try {
      const page = await context.newPage()

      // Only the site itself is sent the Access token, as other hosts like Google Fonts refuse requests carrying it
      if (!external && this.env.CF_ACCESS_CLIENT_ID && this.env.CF_ACCESS_CLIENT_SECRET) {
        const session = await page.createCDPSession()
        const access = [
          { name: "CF-Access-Client-Id", value: this.env.CF_ACCESS_CLIENT_ID },
          { name: "CF-Access-Client-Secret", value: this.env.CF_ACCESS_CLIENT_SECRET },
        ]

        session.on("Fetch.requestPaused", ({ requestId, request }) => {
          const headers = [...Object.entries(request.headers).map(([name, value]) => ({ name, value })), ...access]

          // A request can be gone by now, e.g. when the page is closing
          session.send("Fetch.continueRequest", { requestId, headers }).catch(() => {})
        })

        await session.send("Fetch.enable", { patterns: [{ urlPattern: `${new URL(url).origin}/*` }] })
      }

      await page.setViewport({ width, height, deviceScaleFactor: Math.max(zoom, 1) })

      // Emulate media queries like @media print or (prefers-color-scheme: dark). Puppeteer's own helper won't take
      // prefers-contrast, so this goes to Chrome directly, on a session that stays open as long as the page
      const features = [
        theme && { name: "prefers-color-scheme", value: theme },
        contrast && { name: "prefers-contrast", value: contrast },
        motion && { name: "prefers-reduced-motion", value: motion },
      ].filter((x) => x)

      if (media || features.length) {
        const session = await page.createCDPSession()

        await session.send("Emulation.setEmulatedMedia", { media: media ?? "", features })
      }

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
      await page.evaluate("document.fonts.ready")

      if (VIDEO_FORMATS.includes(format)) {
        return await record(page, {
          format,
          ...output,
          duration,
          effect,
          fps,
          quality,
          scroll,
          clip: shrink < 1 ? { x: 0, y: 0, width, height, scale: shrink } : undefined,
        })
      }

      if (format === "pdf") {
        return await page.pdf({
          format: "A4",
          margin: { top: 20, right: 40, bottom: 20, left: 40 },
        })
      }

      return await page.screenshot({
        clip: { width, height, x: 0, y: 0, scale: shrink },
        ...(format === "jpg" ? { type: "jpeg", quality: quality ?? DEFAULT_QUALITY } : {}),
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
