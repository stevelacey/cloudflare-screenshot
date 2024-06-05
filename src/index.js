import puppeteer from '@cloudflare/puppeteer'
import { regexMerge } from "./support"

export default {
  async fetch(request, env) {
    const id = env.BROWSER.idFromName("browser")
    const obj = env.BROWSER.get(id)

    // Send a request to the Durable Object, then await its response
    const response = await obj.fetch(request.url)

    return response
  }
}

const pattern = regexMerge(
  /^(?<base>https:\/\/[\w\.\/]+)\/screenshot/,
  /(?:\/(?<width>[0-9]+)x(?<height>[0-9]+))?/,
  /(?<path>\/.*?)/,
  /(?:@(?<scale>[2-4])x)?/,
  /(?:\.png)?/,
  /(?<query>\?.*)?$/,
)

const defaults = {
  width: 1200,
  height: 630,
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

    const { base, path, width, height, maxage, scale } = {
      ...defaults,
      ...settings,
      width: parseInt(settings.width ?? defaults.width),
      height: parseInt(settings.height ?? defaults.height),
      scale: parseInt(settings.scale ?? defaults.scale),
    }

    const params = [
      ...settings.query ? settings.query.trim('?').split('&') : [],
      ...this.env.QUERY_PARAMS ? this.env.QUERY_PARAMS.trim('?').split('&') : [],
    ]

    const query = params ? `?${params.join('&')}` : null

    const url = [base, path, query].filter(x => x).join('')

    // if there's a browser session open, re-use it
    if (!this.browser || !this.browser.isConnected()) {
      console.log(`Browser DO: Starting new instance`)

      try {
        this.browser = await puppeteer.launch(this.env.MYBROWSER)
      } catch (e) {
        console.log(`Browser DO: Could not start browser instance. Error: ${e}`)
      }
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0

    const page = await this.browser.newPage()

    await page.setViewport({ width, height, deviceScaleFactor: scale })

    await page.goto(url, { waitUntil: "networkidle0" })

    const screenshot = await page.screenshot({ clip: { width, height, x: 0, y: 0 }})

    // const fileName = "screenshot_" + width[i] + "x" + height[i]

    // const sc = await page.screenshot({ path: fileName + ".jpg" })

    // await this.env.BUCKET.put(folder + "/"+ fileName + ".jpg", sc)

    await page.close()

    // Reset keptAlive after performing tasks to the DO
    this.keptAliveInSeconds = 0

    // Set the first alarm to keep DO alive
    const currentAlarm = await this.storage.getAlarm()

    if (currentAlarm == null) {
      console.log(`Browser DO: setting alarm`)
      const TEN_SECONDS = 10 * 1000
      await this.storage.setAlarm(Date.now() + TEN_SECONDS)
    }

    return new Response(screenshot, {
      headers: {
        "Cache-Control": `public, max-age=${maxage}`,
        "Content-Type": "image/png",
        "Expires": new Date(Date.now() + maxage * 1000).toUTCString(),
      },
    })
  }

  async alarm() {
    this.keptAliveInSeconds += 10

    // Extend browser DO life
    if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
      console.log(`Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`)
      await this.storage.setAlarm(Date.now() + 10 * 1000)
      // You could ensure the ws connection is kept alive by requesting something
      // or just let it close automatically when there  is no work to be done
      // for example, `await this.browser.version()`
    } else {
      console.log(`Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`)
      if (this.browser) {
        console.log(`Closing browser.`)
        await this.browser.close()
      }
    }
  }
}
