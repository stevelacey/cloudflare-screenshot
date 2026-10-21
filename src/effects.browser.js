;(() => {
  // Deterministic randomness, so the same frame always looks the same
  const random = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const canvases = {}

  const scratch = (name, width, height) => {
    canvases[name] ??= new OffscreenCanvas(width, height)

    const canvas = canvases[name]

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    const context = canvas.getContext("2d")

    context.globalCompositeOperation = "source-over"
    context.globalAlpha = 1

    return { canvas, context }
  }

  // A copy of the frame so far, to draw parts of it back somewhere else
  const snapshot = (context) => {
    const { width, height } = context.canvas
    const copy = scratch("snapshot", width, height)

    copy.context.drawImage(context.canvas, 0, 0)

    return copy.canvas
  }

  const wash = (context, color, alpha) => {
    if (alpha <= 0) {
      return
    }

    context.save()
    context.globalAlpha = Math.min(alpha, 1)
    context.fillStyle = color
    context.fillRect(0, 0, context.canvas.width, context.canvas.height)
    context.restore()
  }

  const shake = (context, dx, dy) => {
    const copy = snapshot(context)

    context.fillStyle = "#000"
    context.fillRect(0, 0, context.canvas.width, context.canvas.height)
    context.drawImage(copy, dx, dy)
  }

  // Pulls red, green and blue apart sideways, like a misaligned picture tube
  const split = (context, amount) => {
    if (amount < 0.5) {
      return
    }

    const { width, height } = context.canvas
    const copy = snapshot(context)

    context.save()
    context.fillStyle = "#000"
    context.fillRect(0, 0, width, height)
    context.globalCompositeOperation = "lighter"

    for (const [color, dx] of [
      ["#f00", -amount],
      ["#0f0", 0],
      ["#00f", amount],
    ]) {
      const channel = scratch(color, width, height)

      channel.context.drawImage(copy, 0, 0)
      channel.context.globalCompositeOperation = "multiply"
      channel.context.fillStyle = color
      channel.context.fillRect(0, 0, width, height)
      context.drawImage(channel.canvas, dx, 0)
    }

    context.restore()
  }

  // Shifts random bands of the picture sideways
  const tear = (context, rand, bands, shift) => {
    const { width, height } = context.canvas
    const copy = snapshot(context)

    for (let i = 0; i < bands; i++) {
      const y = rand() * height
      const band = 2 + (rand() * height) / 12

      context.drawImage(copy, 0, y, width, band, (rand() - 0.5) * 2 * shift, y, width, band)
    }
  }

  const scanlines = (context, alpha) => {
    const { width, height } = context.canvas

    context.save()
    context.fillStyle = `rgba(0, 0, 0, ${alpha})`

    for (let y = 0; y < height; y += 3) {
      context.fillRect(0, y, width, 1)
    }

    context.restore()
  }

  const noise = (context, rand, alpha) => {
    const { width, height } = context.canvas
    const grain = scratch("noise", Math.ceil(width / 2), Math.ceil(height / 2))
    const image = grain.context.createImageData(grain.canvas.width, grain.canvas.height)

    for (let i = 0; i < image.data.length; i += 4) {
      const value = rand() * 255

      image.data[i] = image.data[i + 1] = image.data[i + 2] = value
      image.data[i + 3] = 255
    }

    grain.context.putImageData(image, 0, 0)

    context.save()
    context.globalAlpha = alpha
    context.globalCompositeOperation = "overlay"
    context.imageSmoothingEnabled = false
    context.drawImage(grain.canvas, 0, 0, width, height)
    context.restore()
  }

  const vignette = (context, strength) => {
    const { width, height } = context.canvas
    const gradient = context.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.4, width / 2, height / 2, Math.hypot(width, height) / 2)

    gradient.addColorStop(0, "rgba(0, 0, 0, 0)")
    gradient.addColorStop(1, `rgba(0, 0, 0, ${strength})`)

    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
  }

  // Redraws the picture through a canvas filter, like "sepia(0.8)"
  const grade = (context, filter) => {
    const copy = snapshot(context)

    context.save()
    context.filter = filter
    context.drawImage(copy, 0, 0)
    context.restore()
  }

  // Shifts each strip of rows sideways by however much offset says, for wobbles and ripples
  const ripple = (context, strip, offset) => {
    const { width, height } = context.canvas
    const copy = snapshot(context)

    for (let y = 0; y < height; y += strip) {
      context.drawImage(copy, 0, y, width, strip, offset(y), y, width, strip)
    }
  }

  // Eases in and out
  const ease = (progress) => (1 - Math.cos(Math.PI * progress)) / 2

  // An old television: scanlines, a rolling bar, grain, flicker and the odd jump
  const crt = (context, { frame, fps }) => {
    const { width, height } = context.canvas
    const rand = random(frame + 1)

    if (rand() < 0.06) {
      shake(context, (rand() - 0.5) * width * 0.01, 0)
    }

    split(context, Math.max(1, width / 700))

    const y = (((frame / fps) * 0.35) % 1) * height * 1.4 - height * 0.2
    const bar = context.createLinearGradient(0, y - height * 0.1, 0, y + height * 0.1)

    bar.addColorStop(0, "rgba(255, 255, 255, 0)")
    bar.addColorStop(0.5, "rgba(255, 255, 255, 0.07)")
    bar.addColorStop(1, "rgba(255, 255, 255, 0)")
    context.fillStyle = bar
    context.fillRect(0, 0, width, height)

    scanlines(context, 0.22)
    noise(context, rand, 0.12)
    wash(context, "#000", 0.02 + rand() * 0.06)
    vignette(context, 0.55)
  }

  window.__effects = {
    crt,

    // Bursts of digital corruption that come and go
    glitch(context, { frame, fps }) {
      const { width, height } = context.canvas
      // Each broken picture holds for a few frames, with calm stretches between bursts
      const rand = random(Math.floor(frame / 2) + 1)
      const burst = random(Math.floor(frame / Math.max(1, Math.round(fps / 6))) + 99)() < 0.33

      if (!burst) {
        split(context, 1)

        return
      }

      const intensity = 0.4 + rand() * 0.6

      tear(context, rand, 4 + Math.floor(rand() * 10), width * 0.08 * intensity)
      split(context, (3 + rand() * 12 * intensity) * (width / 1280))

      context.save()
      context.globalCompositeOperation = "difference"

      for (let i = 0; i < 1 + rand() * 5; i++) {
        context.fillStyle = `hsl(${rand() * 360} 100% 50%)`
        context.fillRect(rand() * width, rand() * height, rand() * width * 0.3, 2 + rand() * height * 0.05)
      }

      context.restore()

      scanlines(context, 0.08)
    },

    // An old television switching on, then off again at the end
    power(context, timing) {
      const { width, height } = context.canvas
      const { frame, fps, frames } = timing
      const phase = Math.min(1, frame / (fps * 0.6), (frames - 1 - frame) / (fps * 0.6))

      crt(context, timing)

      if (phase >= 1) {
        return
      }

      const copy = snapshot(context)
      // Opens out sideways as a bright line, then top to bottom
      const w = phase < 0.5 ? width * (phase / 0.5) : width
      const h = phase < 0.5 ? Math.max(2, height * 0.005) : Math.max(2, height * ((phase - 0.5) / 0.5) ** 2)
      const x = (width - w) / 2
      const y = (height - h) / 2

      context.fillStyle = "#000"
      context.fillRect(0, 0, width, height)
      context.drawImage(copy, x, y, w, h)

      context.save()
      context.globalAlpha = 1 - phase
      context.fillStyle = "#fff"
      context.shadowColor = "#cfe3ff"
      context.shadowBlur = 20
      context.fillRect(x, y, w, h)
      context.restore()
    },

    // A worn tape: faded color that bleeds, wobbly tracking, a noisy band at the bottom and the odd tracking roll
    vhs(context, timing) {
      const { width, height } = context.canvas
      const { frame, fps } = timing
      const rand = random(frame + 1)
      const t = frame / fps

      grade(context, "contrast(0.9) brightness(1.05) saturate(0.8) sepia(0.12)")

      // Color smears sideways
      context.save()
      context.globalCompositeOperation = "screen"
      context.globalAlpha = 0.25
      context.filter = `blur(${Math.max(1, width / 400)}px) saturate(2)`
      context.drawImage(snapshot(context), Math.max(2, width / 300), 0)
      context.restore()

      ripple(context, 2, (y) => Math.sin(y * 0.04 + t * 9) * width * 0.0015 + (rand() < 0.02 ? (rand() - 0.5) * width * 0.02 : 0))
      split(context, Math.max(1.5, width / 500))

      // The tracking rolls through now and then, tearing the rows it passes
      const roll = random(Math.floor(t / 1.5) + 3)

      if (roll() < 0.5) {
        const y = height * (1 - ((t % 1.5) / 1.5) * 1.3)
        const row = Math.max(2, height * 0.01)
        const copy = snapshot(context)

        for (let i = 0; i < 6; i++) {
          context.drawImage(copy, 0, y + i * row, width, row, (rand() - 0.5) * width * 0.04, y + i * row, width, row)
        }

        context.fillStyle = "rgba(255, 255, 255, 0.25)"
        context.fillRect(0, y, width, Math.max(1, row / 3))
      }

      // Head switching scrambles the last few rows
      const band = Math.max(4, height * 0.04)
      const copy = snapshot(context)

      for (let y = height - band; y < height; y += 2) {
        context.drawImage(copy, 0, y, width, 2, (rand() - 0.3) * width * 0.05, y, width, 2)
      }

      scanlines(context, 0.12)
      noise(context, rand, 0.1)
    },

    // Old cine film: sepia, grain, the frame weaving in the gate, flicker, dust and scratches
    film(context, { frame, fps }) {
      const { width, height } = context.canvas
      const rand = random(frame + 1)

      grade(context, "sepia(0.85) contrast(1.15) brightness(0.95)")
      shake(context, (rand() - 0.5) * width * 0.003, Math.sin(frame / 3) * height * 0.002 + (rand() - 0.5) * height * 0.003)
      noise(context, rand, 0.18)
      wash(context, rand() < 0.5 ? "#000" : "#fff", rand() * 0.06)

      context.save()

      // Dust, a speck or two most frames
      for (let i = 0; i < Math.floor(rand() * 4); i++) {
        context.fillStyle = `rgba(20, 15, 10, ${0.4 + rand() * 0.4})`
        context.beginPath()
        context.ellipse(rand() * width, rand() * height, 1 + rand() * width * 0.003, 1 + rand() * width * 0.002, rand() * Math.PI, 0, 2 * Math.PI)
        context.fill()
      }

      // A scratch running down the film for a moment
      const scratch = random(Math.floor(frame / Math.max(1, Math.round(fps / 3))) + 11)

      if (scratch() < 0.35) {
        context.fillStyle = `rgba(255, 250, 235, ${0.25 + scratch() * 0.3})`
        context.fillRect(scratch() * width + Math.sin(frame) * 2, 0, Math.max(1, width / 900), height)
      }

      context.restore()

      vignette(context, 0.65)
    },

    // A soft glint of light sweeping across, every couple of seconds
    shine(context, { frame, fps, frames }) {
      const { width, height } = context.canvas
      const sweeps = Math.max(1, Math.round(frames / fps / 2.5))
      const period = frames / sweeps
      const progress = ease(Math.min(1, ((frame % period) / period) * 2.5))
      // Sweep the band along its diagonal from before the top left corner to past the bottom right
      const band = Math.hypot(width * 0.25, height * 0.5)
      const [dx, dy] = [(width * 0.25) / band, (height * 0.5) / band]
      const along = -band + progress * (width * dx + height * dy + band)
      const glint = context.createLinearGradient(dx * along, dy * along, dx * (along + band), dy * (along + band))

      glint.addColorStop(0, "rgba(255, 255, 255, 0)")
      glint.addColorStop(0.5, "rgba(255, 255, 255, 0.35)")
      glint.addColorStop(1, "rgba(255, 255, 255, 0)")

      context.save()
      context.globalCompositeOperation = "soft-light"
      context.fillStyle = glint
      context.fillRect(0, 0, width, height)
      context.globalCompositeOperation = "screen"
      context.globalAlpha = 0.4
      context.fillRect(0, 0, width, height)
      context.restore()
    },
  }
})()
