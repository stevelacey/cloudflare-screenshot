import clock from "./clock.browser.js"
import encoder from "./encoder.browser.js"
import gifenc from "./gifenc.browser.js"
import h264 from "./h264.browser.js"

export const FRAME_RATES = { gif: 10, mp4: 30 }

// Boxes with children, and how many bytes of their own fields precede them
const CONTAINERS = { moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, stsd: 8, avc1: 78 }

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
    output.set([...box.type].map((c) => c.charCodeAt(0)), position + 4)
    output.set(box.payload, position + 8)
    position = write(box.children ?? [], output, position + 8 + box.payload.length)
  }

  return position
}

const find = (boxes, type) => boxes.flatMap((box) => [...(box.type === type ? [box] : []), ...find(box.children ?? [], type)])

// x264 leaves the colour space unlabelled and moov at the end, so label it BT.709 and move moov ahead of mdat to let playback start early
export function optimize(bytes) {
  const boxes = parse(bytes)
  const moov = boxes.find(({ type }) => type === "moov")
  const mdat = boxes.find(({ type }) => type === "mdat")

  if (!moov || !mdat) {
    return bytes
  }

  for (const avc1 of find([moov], "avc1")) {
    avc1.children = [
      ...avc1.children.filter(({ type }) => type !== "colr"),
      // nclx: BT.709 primaries, transfer and matrix, limited range
      { type: "colr", payload: new Uint8Array([..."nclx"].map((c) => c.charCodeAt(0)).concat([0, 1, 0, 1, 0, 1, 0])) },
    ]
  }

  const offsetOf = (list) => list.slice(0, list.indexOf(mdat)).reduce((total, box) => total + sizeOf(box), 0)
  const before = offsetOf(boxes)
  const reordered = [...boxes.slice(0, boxes.indexOf(mdat)).filter((box) => box !== moov), moov, ...boxes.slice(boxes.indexOf(mdat)).filter((box) => box !== moov)]
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

// Take over the page's timers before it loads, so recording can step through them frame by frame
export async function prepare(page) {
  await page.evaluateOnNewDocument(clock)
}

// Screenshot a frame at a time, stepping the page's clock between them, so every frame is captured however slow the connection is
async function capture(page, { duration, fps }) {
  const session = await page.createCDPSession()
  const frames = []

  await page.evaluate(() => {
    window.__clock.freeze()
    window.__clock.advance(0)
  })

  for (let frame = 0; frame < duration * fps; frame++) {
    if (frame) {
      await page.evaluate((ms) => window.__clock.advance(ms), 1000 / fps)
    }

    const { data } = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 100 })

    if (frames.at(-1)?.data === data) {
      frames.at(-1).count++
    } else {
      frames.push({ data, count: 1 })
    }
  }

  await session.detach()

  return frames
}

export async function record(page, { format, width, height, duration }) {
  const fps = FRAME_RATES[format]

  // H.264 needs even dimensions
  const size = format === "mp4" ? { width: width - (width % 2), height: height - (height % 2) } : { width, height }

  const frames = await capture(page, { duration, fps })

  // Encode on a blank page so the recorded page's scripts and CSP, which can block WebAssembly, stay out of the way
  await page.goto("about:blank")

  await page.evaluate(format === "gif" ? `(function (exports) { ${gifenc} })(window.__gifenc = {})` : h264)
  await page.evaluate(encoder)
  await page.evaluate((options) => window.__encoder.start(options), { format, fps, ...size })

  for (const { data, count } of frames) {
    await page.evaluate((data, count) => window.__encoder.add(data, count), data, count)
  }

  const bytes = new Uint8Array(Buffer.from(await page.evaluate(() => window.__encoder.finish()), "base64"))

  return format === "mp4" ? optimize(bytes) : bytes
}
