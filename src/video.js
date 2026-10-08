import clock from "./clock.browser.js"
import encoderSource from "./encoder.browser.js"
import gifenc from "./gifenc.browser.js"
import h264 from "./h264.browser.js"

const CONTAINERS = { moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, stsd: 8, avc1: 78 }

const FRAME_RATES = { gif: 10, mp4: 30, webp: 15 }

const LIBRARIES = { gif: `(function (exports) { ${gifenc} })(window.__gifenc = {})`, mp4: h264 }

function parse(bytes) {
  const boxes = []

  for (let offset = 0; offset < bytes.length; ) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const payload = bytes.slice(offset + 8, offset + size)
    const prefix = CONTAINERS[type]

    boxes.push(prefix === undefined ? { type, payload } : { type, payload: payload.subarray(0, prefix), children: parse(payload.subarray(prefix)) })
    offset += size
  }

  return boxes
}

const sizeOf = (box) => 8 + box.payload.length + (box.children ?? []).reduce((total, child) => total + sizeOf(child), 0)

function write(boxes, output, position = 0) {
  for (const box of boxes) {
    new DataView(output.buffer).setUint32(position, sizeOf(box))
    output.set(
      [...box.type].map((c) => c.charCodeAt(0)),
      position + 4,
    )
    output.set(box.payload, position + 8)
    position = write(box.children ?? [], output, position + 8 + box.payload.length)
  }

  return position
}

const find = (boxes, type) => boxes.flatMap((box) => [...(box.type === type ? [box] : []), ...find(box.children ?? [], type)])

export function optimize(bytes) {
  const boxes = parse(bytes)
  const moov = boxes.find(({ type }) => type === "moov")
  const mdat = boxes.find(({ type }) => type === "mdat")

  if (!moov || !mdat) {
    return bytes
  }

  // Measured before labelling, which grows moov
  const offsetOf = (list) => list.slice(0, list.indexOf(mdat)).reduce((total, box) => total + sizeOf(box), 0)
  const before = offsetOf(boxes)

  for (const avc1 of find([moov], "avc1")) {
    avc1.children = [
      ...avc1.children.filter(({ type }) => type !== "colr"),
      // nclx: BT.709 primaries, transfer and matrix, limited range
      { type: "colr", payload: new Uint8Array([..."nclx"].map((c) => c.charCodeAt(0)).concat([0, 1, 0, 1, 0, 1, 0])) },
    ]
  }
  const reordered = [
    ...boxes.slice(0, boxes.indexOf(mdat)).filter((box) => box !== moov),
    moov,
    ...boxes.slice(boxes.indexOf(mdat)).filter((box) => box !== moov),
  ]
  const shift = offsetOf(reordered) - before

  for (const stco of find([moov], "stco")) {
    const view = new DataView(stco.payload.buffer, stco.payload.byteOffset)

    for (let i = 0; i < view.getUint32(4); i++) {
      view.setUint32(8 + i * 4, view.getUint32(8 + i * 4) + shift)
    }
  }

  const output = new Uint8Array(reordered.reduce((total, box) => total + sizeOf(box), 0))

  write(reordered, output)

  return output
}

export async function prepare(page) {
  await page.evaluateOnNewDocument(clock)
}

// Eases in and out, so a scroll doesn't start or stop with a jolt
const ease = (progress) => (1 - Math.cos(Math.PI * progress)) / 2

const PIXELS = /^(\d+)px$/

// Splits scrolling through each stop in turn into equally long parts as [from, to], pausing at each one between moves
function partsFor(tops) {
  return [
    ...tops.slice(1).flatMap((to, i) => [
      [tops[i], tops[i]],
      [tops[i], to],
    ]),
    [tops.at(-1), tops.at(-1)],
  ]
}

// Where the page is part way through its parts
function position(progress, parts) {
  const part = Math.min(Math.floor(progress * parts.length), parts.length - 1)
  const [from, to] = parts[part]

  return from + (to - from) * ease(progress * parts.length - part)
}

// Where the page scrolls to for each stop, a position like 2000px or an element's id, as far as the page goes. An element
// respects any scroll margin, like one leaving room for a sticky header
async function locate(page, stops) {
  return page.evaluate(
    (stops, pixels) => {
      const tops = stops.map((stop) => {
        const position = stop.match(new RegExp(pixels))
        const element = position ? null : document.getElementById(stop)

        if (position) {
          window.scrollTo({ top: Number(position[1]), behavior: "instant" })
        } else if (element) {
          element.scrollIntoView({ behavior: "instant", block: "start" })
        } else {
          throw new Error(`Nothing to scroll to with the id ${stop}`)
        }

        return window.scrollY
      })

      window.scrollTo({ top: 0, behavior: "instant" })

      return tops
    },
    stops,
    PIXELS.source,
  )
}

// Pauses at the top, then scrolls to each stop in turn, pausing at each one
async function scrolling(page, stops) {
  // Anything loading above a stop moves it, so it is measured again once loaded, and a position may be past the bottom until then
  const positions = stops.map((stop) => Number(stop.match(PIXELS)?.[1] ?? 0))

  await preload(page, Math.max(...positions, ...(await locate(page, stops))))

  return partsFor([0, ...(await locate(page, stops))])
}

// Scrolls through once a screen at a time, so anything that loads as it comes into view is ready before recording
async function preload(page, scroll) {
  await page.evaluate(async (scroll) => {
    for (let top = 0; top < scroll; top += window.innerHeight) {
      window.scrollTo({ top, behavior: "instant" })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    window.scrollTo({ top: scroll, behavior: "instant" })
  }, scroll)
  await page.waitForNetworkIdle()
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }))
}

async function capture(page, encoder, { clip, duration, fps, parts }) {
  const session = await page.createCDPSession()
  let previous
  let count = 0
  let encoding = Promise.resolve()

  const flush = async () => {
    if (!count) {
      return
    }

    await encoding
    encoding = encoder.evaluate((data, count) => window.__encoder.add(data, count), previous, count)
    // Awaited later; avoids an unhandled rejection meanwhile
    encoding.catch(() => {})
    count = 0
  }

  try {
    await page.evaluate(() => {
      window.__clock.freeze()

      return window.__clock.advance(0)
    })

    const frames = duration * fps
    let offset = 0

    for (let frame = 0; frame < frames; frame++) {
      if (frame) {
        const top = parts ? position(frame / (frames - 1), parts) : null

        offset = await page.evaluate(
          async (ms, top) => {
            if (top !== null) {
              window.scrollTo({ top, behavior: "instant" })
            }

            await window.__clock.advance(ms)

            return window.scrollY
          },
          1000 / fps,
          top,
        )
      }

      // A clip is measured from the top of the page, so it follows the scroll to stay on screen
      const { data } = await session.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: clip && { ...clip, y: clip.y + offset } })

      if (data === previous) {
        count++
      } else {
        await flush()
        previous = data
        count = 1
      }
    }

    await flush()
    await encoding
  } finally {
    await session.detach()
  }
}

export async function record(page, { format, width, height, duration, clip, scroll }) {
  const fps = FRAME_RATES[format]

  // H.264 needs even dimensions
  const size = format === "mp4" ? { width: width - (width % 2), height: height - (height % 2) } : { width, height }

  const encoder = await page.browserContext().newPage()

  try {
    if (LIBRARIES[format]) {
      await encoder.evaluate(LIBRARIES[format])
    }

    await encoder.evaluate(encoderSource)

    await encoder.evaluate((options) => window.__encoder.start(options), { format, fps, ...size })

    // Background tabs stop painting, which stalls screenshots
    await page.bringToFront()

    const parts = scroll ? await scrolling(page, scroll) : null

    await capture(page, encoder, { clip, duration, fps, parts })

    const bytes = new Uint8Array(Buffer.from(await encoder.evaluate(() => window.__encoder.finish()), "base64"))

    return format === "mp4" ? optimize(bytes) : bytes
  } finally {
    await encoder.close()
  }
}
