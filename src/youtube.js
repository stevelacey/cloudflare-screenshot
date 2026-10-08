const PLAYER_TIMEOUT = 30 * 1000

// Seconds from a time like 75s or 1m15s
function seconds(time) {
  const { hours = 0, minutes = 0, seconds = 0 } = time?.match(/^(?:(?<hours>\d+)h)?(?:(?<minutes>\d+)m)?(?:(?<seconds>\d+)s)?$/).groups ?? {}

  return hours * 3600 + minutes * 60 + Number(seconds)
}

export function youtube(path, time) {
  const id = path.match(/^\/([\w-]{11})$/)?.[1]

  if (!id) {
    return null
  }

  const start = seconds(time)
  const embed = new URLSearchParams({
    autoplay: 1,
    mute: 1,
    controls: 0,
    start,
    playsinline: 1,
    iv_load_policy: 3,
    cc_load_policy: 0,
    rel: 0,
    disablekb: 1,
    fs: 0,
    hl: "en",
  })

  return { url: `https://www.youtube-nocookie.com/embed/${id}?${embed}`, start }
}

// Wait out any ad, then hold the video paused on the start frame with the player's own interface hidden
export async function cue(page, start) {
  const refusal = await page.evaluate(
    async (start, timeout) => {
      const deadline = performance.now() + timeout

      for (;;) {
        const error = document.querySelector(".ytp-error")
        const video = document.querySelector("video")
        const advert = document.querySelector(".html5-video-player.ad-showing")

        if (error) {
          return error.innerText.trim()
        }

        if (video && !advert && video.readyState >= 3 && video.currentTime > 0) {
          video.pause()
          video.currentTime = start
          await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }))

          break
        }

        // A refused video doesn't always say so
        if (performance.now() > deadline) {
          return "Video did not start"
        }

        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const style = document.createElement("style")

      style.textContent = "body * { visibility: hidden !important } video { visibility: visible !important } body { background: #000 }"
      document.head.append(style)
    },
    start,
    PLAYER_TIMEOUT,
  )

  // YouTube turns away some requests from data centres at random, so another attempt may well get through
  if (refusal) {
    throw Object.assign(new Error(`YouTube: ${refusal}`), { retry: true })
  }
}
