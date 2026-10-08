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
    innerHeight: 720,
    scrollY: 0,
    bottom: Infinity,
    scrollTo: vi.fn(({ top }) => {
      window.scrollY = Math.min(top, window.bottom)
    }),
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
  const encoderPage = {
    close: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (fn, ...args) => (typeof fn === "function" ? fn(...args) : undefined)),
  }
  const elements = {}
  vi.stubGlobal("window", window)
  vi.stubGlobal("document", {
    getElementById: (id) =>
      elements[id] && {
        scrollIntoView: () => {
          window.scrollY = Math.min(elements[id], window.bottom)
        },
      },
  })
  return {
    elements,
    window,
    session,
    encoderPage,
    createCDPSession: vi.fn().mockResolvedValue(session),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    bringToFront: vi.fn().mockResolvedValue(undefined),
    waitForNetworkIdle: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (fn, ...args) => (typeof fn === "function" ? fn(...args) : undefined)),
    browserContext: () => ({ newPage: async () => encoderPage }),
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
    const dataOffset = ftyp.length + moov([0]).length + 8
    const input = Buffer.concat([ftyp, moov([dataOffset]), mdat])

    const output = Buffer.from(optimize(new Uint8Array(input)))

    const offset = ftyp.length + moov([0], colr).length + 8
    expect(output).toEqual(Buffer.concat([ftyp, moov([offset], colr), mdat]))
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
    expect(page.session.send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", optimizeForSpeed: true })
    expect(page.session.detach).toHaveBeenCalled()
    expect(page.goto).not.toHaveBeenCalled()
    expect(page.encoderPage.close).toHaveBeenCalled()
    expect(page.bringToFront.mock.invocationCallOrder[0]).toBeLessThan(page.session.send.mock.invocationCallOrder[0])
    expect(page.encoderPage.evaluate).toHaveBeenCalledWith(expect.stringContaining("gifenc-source"))
    expect(page.encoderPage.evaluate).not.toHaveBeenCalledWith("h264-source")
    expect(page.encoderPage.evaluate).toHaveBeenCalledWith("encoder-source")
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "gif", fps: 10, quality: 80, width: 1281, height: 721 })
    expect(page.window.__encoder.add.mock.calls).toEqual([
      ["a", 3],
      ["b", 7],
    ])
  })

  it("records a WebP without loading an encoder library", async () => {
    const page = createPage(Array(15).fill("a"), base64("webp-bytes"))

    const bytes = await record(page, { format: "webp", width: 1281, height: 721, duration: 1 })

    expect(Buffer.from(bytes).toString()).toBe("webp-bytes")
    expect(page.encoderPage.evaluate).not.toHaveBeenCalledWith("h264-source")
    expect(page.encoderPage.evaluate).not.toHaveBeenCalledWith(expect.stringContaining("gifenc-source"))
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "webp", fps: 15, quality: 80, width: 1281, height: 721 })
    expect(page.window.__encoder.add.mock.calls).toEqual([["a", 15]])
  })

  it("records at the frame rate and quality given", async () => {
    const page = createPage(Array(8).fill("a"), base64("webp-bytes"))

    await record(page, { format: "webp", width: 640, height: 360, duration: 1, fps: 8, quality: 60 })

    expect(page.window.__clock.advance.mock.calls).toEqual([[0], ...Array(7).fill([125])])
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "webp", fps: 8, quality: 60, width: 640, height: 360 })
    expect(page.window.__encoder.add.mock.calls).toEqual([["a", 8]])
  })

  it("captures frames at the size given by the clip", async () => {
    const page = createPage(["a"], base64("webp-bytes"))
    const clip = { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 }

    await record(page, { format: "webp", width: 640, height: 360, duration: 1 / 15, clip })

    expect(page.session.send).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip })
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "webp", fps: 15, quality: 80, width: 640, height: 360 })
  })

  it("loads the page down to the stop, then pauses, scrolls smoothly to it, and pauses again", async () => {
    const page = createPage(Array(13).fill("a"), base64("gif-bytes"))

    await record(page, { format: "gif", width: 10, height: 10, duration: 1.3, scroll: ["1000px"] })

    const tops = page.window.scrollTo.mock.calls.map(([{ top }]) => Math.round(top))

    // Measured, loaded a screen at a time, then measured again
    expect(tops.slice(0, 8)).toEqual([1000, 0, 0, 720, 1000, 0, 1000, 0])
    expect(page.waitForNetworkIdle.mock.invocationCallOrder[0]).toBeLessThan(page.window.scrollTo.mock.invocationCallOrder[5])
    expect(tops.slice(8)).toEqual([0, 0, 0, 0, 146, 500, 854, 1000, 1000, 1000, 1000, 1000])
    expect(page.window.__clock.advance).toHaveBeenCalledTimes(13)
  })

  it("moves the clip with the scroll, as it is measured from the top of the page", async () => {
    const page = createPage(Array(13).fill("a"), base64("gif-bytes"))
    const clip = { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 }

    await record(page, { format: "gif", width: 640, height: 360, duration: 1.3, scroll: ["1000px"], clip })

    const offsets = page.session.send.mock.calls.map(([, { clip }]) => Math.round(clip.y))

    expect(offsets).toEqual([0, 0, 0, 0, 0, 146, 500, 854, 1000, 1000, 1000, 1000, 1000])
  })

  it("scrolls to each position in turn, back up as well as down", async () => {
    const page = createPage(Array(11).fill("a"), base64("gif-bytes"))

    await record(page, { format: "gif", width: 10, height: 10, duration: 1.1, scroll: ["2000px", "0px"] })

    const tops = page.window.scrollTo.mock.calls.slice(-10).map(([{ top }]) => Math.round(top))

    expect(tops).toEqual([0, 0, 1000, 2000, 2000, 2000, 1000, 0, 0, 0])
  })

  it("stops at the bottom of the page for a position past it", async () => {
    const page = createPage(Array(7).fill("a"), base64("gif-bytes"))
    page.window.bottom = 1500

    await record(page, { format: "gif", width: 10, height: 10, duration: 0.7, scroll: ["4000px"] })

    const tops = page.window.scrollTo.mock.calls.map(([{ top }]) => Math.round(top))

    // The page may only grow that far once loaded
    expect(tops).toContain(4000)
    expect(tops.slice(-6)).toEqual([0, 0, 750, 1500, 1500, 1500])
  })

  it("pauses at the top, then scrolls to each element in turn, pausing at each", async () => {
    const page = createPage(Array(15).fill("a"), base64("gif-bytes"))

    Object.assign(page.elements, { a: 500, b: 1500, c: 3000 })
    // Images loading above them push them down
    page.waitForNetworkIdle.mockImplementation(async () => {
      Object.assign(page.elements, { a: 600, b: 1600, c: 3100 })
    })

    await record(page, { format: "gif", width: 10, height: 10, duration: 1.5, scroll: ["a", "b", "c"] })

    const tops = page.window.scrollTo.mock.calls.map(([{ top }]) => Math.round(top))

    expect(tops.slice(0, 7)).toEqual([0, 0, 720, 1440, 2160, 2880, 3000])
    expect(tops.slice(-14)).toEqual([0, 0, 300, 600, 600, 600, 1100, 1600, 1600, 1600, 2350, 3100, 3100, 3100])
  })

  it("fails without an element to scroll to", async () => {
    const page = createPage([], base64("gif-bytes"))

    await expect(record(page, { format: "gif", width: 10, height: 10, duration: 1, scroll: ["missing"] })).rejects.toThrow(
      "Nothing to scroll to with the id missing",
    )
  })

  it("leaves the page where it is without a scroll", async () => {
    const page = createPage(Array(10).fill("a"), base64("gif-bytes"))

    await record(page, { format: "gif", width: 10, height: 10, duration: 1 })

    expect(page.window.scrollTo).not.toHaveBeenCalled()
    expect(page.waitForNetworkIdle).not.toHaveBeenCalled()
  })

  it("records an MP4 with the bundled encoder at even dimensions and optimizes it", async () => {
    const ftyp = box("ftyp", 0)
    const mdat = box("mdat", 0)
    const page = createPage(Array(60).fill("a"), Buffer.concat([ftyp, mdat, moov([ftyp.length + 8])]).toString("base64"))

    const bytes = await record(page, { format: "mp4", width: 1281, height: 721, duration: 2 })

    expect(Buffer.from(bytes)).toEqual(Buffer.concat([ftyp, moov([ftyp.length + 8 + moov([0], colr).length], colr), mdat]))
    expect(page.encoderPage.evaluate).toHaveBeenCalledWith("h264-source")
    expect(page.encoderPage.evaluate).not.toHaveBeenCalledWith(expect.stringContaining("gifenc-source"))
    expect(page.window.__encoder.start).toHaveBeenCalledWith({ format: "mp4", fps: 30, quality: 80, width: 1280, height: 720 })
    expect(page.window.__encoder.add.mock.calls).toEqual([["a", 60]])
  })
})

describe("record failures", () => {
  it("stops recording when encoding a frame fails", async () => {
    const page = createPage(["a", "b", "c"], base64("gif-bytes"))
    page.window.__encoder.add.mockRejectedValueOnce(new Error("encode failed"))

    await expect(record(page, { format: "gif", width: 10, height: 10, duration: 0.3 })).rejects.toThrow("encode failed")
    expect(page.session.detach).toHaveBeenCalled()
    expect(page.encoderPage.close).toHaveBeenCalled()
  })
})
