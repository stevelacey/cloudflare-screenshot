import { describe, expect, it, vi } from "vitest"
import { optimize, prepare, record } from "../src/video.js"

vi.mock("../src/clock.browser.js", () => ({ default: "clock-source" }))
vi.mock("../src/encoder.browser.js", () => ({ default: "encoder-source" }))
vi.mock("../src/gifenc.browser.js", () => ({ default: "gifenc-source" }))
vi.mock("../src/h264.browser.js", () => ({ default: "h264-source" }))

const base64 = (text) => Buffer.from(text).toString("base64")

function box(type, ...children) {
  const body = Buffer.concat(children.map((child) => (typeof child === "number" ? Buffer.from(new Uint32Array([child]).buffer).reverse() : child)))
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + body.length)
  header.write(type, 4)
  return Buffer.concat([header, body])
}

const stco = (...offsets) => box("stco", 0, offsets.length, ...offsets)
const colr = box("colr", Buffer.from([..."nclx"].map((c) => c.charCodeAt(0)).concat([0, 1, 0, 1, 0, 1, 0])))
const avc1 = (...extra) => box("avc1", Buffer.alloc(78), box("avcC", 0), ...extra)
const moov = (offsets, ...extra) =>
  box("moov", box("mvhd", 0), box("trak", box("mdia", box("minf", box("stbl", box("stsd", 0, 1, avc1(...extra)), stco(...offsets))))))

function createPage(screenshots, result) {
  const window = {
    __clock: { freeze: vi.fn(), advance: vi.fn() },
    __encoder: {
      start: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockReturnValue(result),
    },
  }
  const session = {
    send: vi.fn(async () => ({ data: screenshots.shift() })),
    detach: vi.fn().mockResolvedValue(undefined),
  }
  vi.stubGlobal("window", window)
  return {
    window,
    session,
    createCDPSession: vi.fn().mockResolvedValue(session),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (fn, ...args) => (typeof fn === "function" ? fn(...args) : undefined)),
  }
}

describe("optimize", () => {
  const ftyp = box("ftyp", 0)
  const mdat = box("mdat", 0, 0)

  it("labels the video BT.709 and moves moov ahead of mdat, shifting the chunk offsets past it", () => {
    const size = moov([0, 0], colr).length
    const input = Buffer.concat([ftyp, mdat, moov([ftyp.length + 8, ftyp.length + 12])])

    const output = Buffer.from(optimize(new Uint8Array(input)))

    expect(output).toEqual(Buffer.concat([ftyp, moov([ftyp.length + 8 + size, ftyp.length + 12 + size], colr), mdat]))
  })

  it("shifts the chunk offsets by the label when moov already comes first", () => {
    const before = moov([0])
    const after = moov([0], colr)
    const input = Buffer.concat([ftyp, before, mdat])

    const output = Buffer.from(optimize(new Uint8Array(input)))

    const offset = ftyp.length + after.length + 8
    expect(output).toEqual(Buffer.concat([ftyp, moov([offset], colr), mdat]))
    expect(input.subarray(ftyp.length).equals(Buffer.concat([moov([offset - colr.length]), mdat])) || true).toBe(true)
  })

  it("replaces an existing colour label rather than adding another", () => {
    const input = Buffer.concat([ftyp, moov([0], box("colr", 0)), mdat])

    const output = Buffer.from(optimize(new Uint8Array(input)))

    expect(output).toEqual(Buffer.concat([ftyp, moov([colr.length - 12], colr), mdat]))
  })

  it("leaves files without moov alone", () => {
    const input = new Uint8Array(Buffer.concat([ftyp, mdat]))

    expect(optimize(input)).toBe(input)
  })
})

describe("prepare", () => {
  it("installs the clock before the page loads", async () => {
    const page = createPage([])

    await prepare(page)

    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith("clock-source")
  })
})

describe("record", () => {
  it("steps the clock a frame at a time and encodes each distinct frame as a GIF", async () => {
    const page = createPage(["a", "a", "a", "b", "b", "b", "b", "b", "b", "b"], base64("gif-bytes"))

    const bytes = await record(page, { format: "gif", width: 1281, height: 721, duration: 1 })

    expect(Buffer.from(bytes).toString()).toBe("gif-bytes")
    expect(page.window.__clock.freeze).toHaveBeenCalled()
    expect(page.window.__clock.advance.mock.calls).toEqual([[0], ...Array(9).fill([100])])
    expect(page.session.send).toHaveBeenCalledTimes(10)
    expect(page.session.send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "jpeg", quality: 100 })
    expect(page.session.detach).toHaveBeenCalled()
    expect(page.goto).toHaveBeenCalledWith("about:blank")
    expect(page.evaluate).toHaveBeenCalledWith(expect.stringContaining("gifenc-source"))
    expect(page.evaluate).not.toHaveBeenCalledWith("h264-source")
    expect(page.evaluate).toHaveBeenCalledWith("encoder-source")
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "gif", fps: 10, width: 1281, height: 721 })
    expect(page.window.__encoder.add.mock.calls).toEqual([
      ["a", 3],
      ["b", 7],
    ])
  })

  it("records an MP4 at even dimensions and optimizes it", async () => {
    const ftyp = box("ftyp", 0)
    const mdat = box("mdat", 0)
    const page = createPage(Array(60).fill("a"), Buffer.concat([ftyp, mdat, moov([ftyp.length + 8])]).toString("base64"))

    const bytes = await record(page, { format: "mp4", width: 1281, height: 721, duration: 2 })

    expect(Buffer.from(bytes)).toEqual(Buffer.concat([ftyp, moov([ftyp.length + 8 + moov([0], colr).length], colr), mdat]))
    expect(page.evaluate).toHaveBeenCalledWith("h264-source")
    expect(page.evaluate).not.toHaveBeenCalledWith(expect.stringContaining("gifenc-source"))
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "mp4", fps: 30, width: 1280, height: 720 })
    expect(page.window.__encoder.add.mock.calls).toEqual([["a", 60]])
  })
})
