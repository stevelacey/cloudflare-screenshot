import puppeteer from "@cloudflare/puppeteer"
import { regexMerge } from "./support"

const BROWSER_CACHE_TTL = 7 * 24 * 60 * 60
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
  const match = request.url.match(URL_PATTERN)

  if (!match) return new Response("Not Found", { status: 404 })

  const settings = match.groups

  const { base, format, path, width, height, scale } = {
    ...settings,
    format: settings.format ?? DEFAULT_FORMAT,
    width: parseInt(settings.width ?? DEFAULT_WIDTH),
    height: parseInt(settings.height ?? DEFAULT_HEIGHT),
    scale: parseInt(settings.scale ?? DEFAULT_SCALE),
  }

  const params = [
    ...settings.query ? settings.query.replace(/^\?/, "").split("&") : [],
    ...env.QUERY_PARAMS ? env.QUERY_PARAMS.replace(/^\?/, "").split("&") : [],
  ]

  const query = params ? `?${params.join("&")}` : null

  const url = [base, path, query].filter(x => x).join("")

  const browser = await puppeteer.launch(env.BROWSER)

  try {
    const page = await browser.newPage()

    try {
      if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
        await page.setExtraHTTPHeaders({
          "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
          "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
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

      const response = new Response(screenshot, {
        headers: {
          "Cache-Control": `public, max-age=${BROWSER_CACHE_TTL}`,
          "Content-Type": format === "pdf" ? "application/pdf" : `image/${format}`,
          "Expires": new Date(Date.now() + BROWSER_CACHE_TTL * 1000).toUTCString(),
        },
      })

      if (response.ok) {
        ctx.waitUntil(
          response.clone().arrayBuffer().then(async (buffer) => {
            await env.SCREENSHOTS.put(key, buffer)
          }).catch(console.error)
        )
      }

      return response
    } finally {
      page.close().catch(() => { })
    }
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
  } finally {
    browser.close().catch(() => { })
  }
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

    if (!match) return new Response("Not Found", { status: 404 })

    const { base, path, query, format } = match.groups

    const hostname = new URL(base).hostname
    const key = `${hostname}${path}${query || ""}`

    // Check R2 bucket for existing screenshot
    const existing = await env.SCREENSHOTS.get(key)

    if (existing) {
      const uploaded = existing.uploaded ? new Date(existing.uploaded).getTime() : null

      // If stale, trigger background refresh for next visitor
      if (uploaded && (Date.now() - uploaded > STORAGE_TTL * 1000)) {
        ctx.waitUntil(fetchScreenshot(request, env, key, ctx).catch(console.error))
      }

      return await serveScreenshot(existing.body, format)
    }

    if (request.method === "HEAD") {
      return await serveScreenshot(null, format)
    }

    // No existing screenshot, generate a new one
    return await fetchScreenshot(request, env, key, ctx)
  }
}
