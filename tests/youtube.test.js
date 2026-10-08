import { afterEach, describe, expect, it, vi } from "vitest"
import { cue, youtube } from "../src/youtube.js"

describe("youtube", () => {
  it("builds a muted, chromeless embed starting at the requested second", () => {
    const video = youtube("/_TcEfYlW4PA", "72s")

    expect(video.start).toBe(72)
    expect(video.url).toBe(
      "https://www.youtube-nocookie.com/embed/_TcEfYlW4PA?autoplay=1&mute=1&controls=0&start=72&playsinline=1&iv_load_policy=3&cc_load_policy=0&rel=0&disablekb=1&fs=0&hl=en",
    )
  })

  it("reads the time in hours, minutes and seconds", () => {
    expect(youtube("/_TcEfYlW4PA", "75s").start).toBe(75)
    expect(youtube("/_TcEfYlW4PA", "1m15s").start).toBe(75)
    expect(youtube("/_TcEfYlW4PA", "2m").start).toBe(120)
    expect(youtube("/_TcEfYlW4PA", "1h2m3s").start).toBe(3723)
  })

  it("starts at the beginning without a time", () => {
    expect(youtube("/_TcEfYlW4PA").start).toBe(0)
  })

  it("ignores paths without a video", () => {
    expect(youtube("/")).toBeNull()
    expect(youtube("/too-short")).toBeNull()
    expect(youtube("/_TcEfYlW4PA/more")).toBeNull()
    expect(youtube("/@allin")).toBeNull()
  })
})

describe("cue", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function createPlayer({ error, states }) {
    const video = {
      readyState: 0,
      currentTime: 0,
      pause: vi.fn(),
      addEventListener: vi.fn((_event, resolve) => resolve()),
    }
    const head = { append: vi.fn() }
    let poll = 0

    vi.stubGlobal("document", {
      head,
      createElement: () => ({}),
      querySelector: (selector) => {
        const state = states[Math.min(poll, states.length - 1)]

        if (selector === ".ytp-error") {
          return error ? { innerText: ` ${error} ` } : null
        }

        if (selector === "video") {
          poll++
          Object.assign(video, state.video)

          return state.video ? video : null
        }

        return state.advert ? {} : null
      },
    })

    return { video, head, page: { evaluate: (fn, ...args) => fn(...args) } }
  }

  it("waits out ads, then pauses on the start frame with the player interface hidden", async () => {
    vi.useFakeTimers()
    const { video, head, page } = createPlayer({
      states: [{}, { video: { readyState: 4, currentTime: 1 }, advert: true }, { video: { readyState: 4, currentTime: 2 } }],
    })

    const cued = cue(page, 72)
    await vi.advanceTimersByTimeAsync(300)
    await cued

    expect(video.pause).toHaveBeenCalled()
    expect(video.currentTime).toBe(72)
    expect(head.append).toHaveBeenCalledWith({ textContent: expect.stringContaining("video { visibility: visible !important }") })
  })

  it("reports the player's refusal as worth another attempt", async () => {
    const { page } = createPlayer({ error: "An error occurred", states: [{}] })

    const error = await cue(page, 0).catch((error) => error)

    expect(error.message).toBe("YouTube: An error occurred")
    expect(error.retry).toBe(true)
  })

  it("treats a video that never starts as refused, so it is tried again", async () => {
    vi.useFakeTimers()
    const { page } = createPlayer({ states: [{ video: { readyState: 1, currentTime: 0 } }] })

    const cued = cue(page, 0).catch((error) => error)
    await vi.advanceTimersByTimeAsync(31 * 1000)
    const error = await cued

    expect(error.message).toBe("YouTube: Video did not start")
    expect(error.retry).toBe(true)
  })
})
