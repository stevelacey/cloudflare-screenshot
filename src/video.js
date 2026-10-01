import clock from "./clock.browser.js"
import encoderSource from "./encoder.browser.js"
import gifenc from "./gifenc.browser.js"
import h264 from "./h264.browser.js"

const CONTAINERS = { moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, stsd: 8, avc1: 78 }

const FRAME_RATES = { gif: 10, mp4: 30 }

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

async function capture(page, encoder, { duration, fps }) {
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
      window.__clock.advance(0)
    })

    for (let frame = 0; frame < duration * fps; frame++) {
      if (frame) {
        await page.evaluate((ms) => window.__clock.advance(ms), 1000 / fps)
      }

      const { data } = await session.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })

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

export async function record(page, { format, width, height, duration }) {
  const fps = FRAME_RATES[format]

  // H.264 needs even dimensions
  const size = format === "mp4" ? { width: width - (width % 2), height: height - (height % 2) } : { width, height }

  const encoder = await page.browserContext().newPage()

  try {
    await encoder.evaluate(format === "gif" ? `(function (exports) { ${gifenc} })(window.__gifenc = {})` : h264)
    await encoder.evaluate(encoderSource)

    await encoder.evaluate((options) => window.__encoder.start(options), { format, fps, ...size })

    // Background tabs stop painting, which stalls screenshots
    await page.bringToFront()
    await capture(page, encoder, { duration, fps })

    const bytes = new Uint8Array(Buffer.from(await encoder.evaluate(() => window.__encoder.finish()), "base64"))

    return format === "mp4" ? optimize(bytes) : bytes
  } finally {
    await encoder.close()
  }
}
