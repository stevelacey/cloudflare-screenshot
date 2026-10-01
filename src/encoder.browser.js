// Injected into the browser as text to encode screencast frames, where decoding and encoding are cheap
const toBase64 = (bytes) => {
  let binary = ""

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

// x264's own RGB conversion uses BT.601, which players show with shifted colours, so convert to BT.709 limited range here
const toYuv = (rgba, width, height) => {
  const yuv = new Uint8Array((width * height * 3) / 2)
  const u = width * height
  const v = u + u / 4

  for (let i = 0; i < width * height; i++) {
    yuv[i] = 16 + ((0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) * 219) / 255
  }

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let r = 0
      let g = 0
      let b = 0

      for (const i of [y * width + x, y * width + x + 1, (y + 1) * width + x, (y + 1) * width + x + 1]) {
        r += rgba[i * 4] / 4
        g += rgba[i * 4 + 1] / 4
        b += rgba[i * 4 + 2] / 4
      }

      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const j = (y / 2) * (width / 2) + x / 2

      yuv[u + j] = 128 + ((b - luma) / 1.8556) * (224 / 255)
      yuv[v + j] = 128 + ((r - luma) / 1.5748) * (224 / 255)
    }
  }

  return yuv
}

window.__encoder = {
  async start({ format, width, height, fps }) {
    this.fps = fps
    this.canvas = new OffscreenCanvas(width, height)
    this.context = this.canvas.getContext("2d", { willReadFrequently: true })

    if (format === "gif") {
      this.gif = window.__gifenc.GIFEncoder()

      return
    }

    // x264 rather than WebCodecs, as Chrome's H.264 encoder ignores bitrate and looks soft
    this.h264 = await window.HME.createH264MP4Encoder()

    Object.assign(this.h264, { width, height, frameRate: fps, quantizationParameter: 16, speed: 5, groupOfPictures: fps * 2 })

    this.h264.initialize()
  },

  async add(data, count) {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }))

    this.context.drawImage(bitmap, 0, 0, this.canvas.width, this.canvas.height)
    bitmap.close()

    const { width, height } = this.canvas
    const { data: rgba } = this.context.getImageData(0, 0, width, height)

    if (this.gif) {
      const { quantize, applyPalette } = window.__gifenc
      const palette = quantize(rgba, 256)

      this.gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay: (count * 1000) / this.fps })

      return
    }

    const yuv = toYuv(rgba, width, height)

    for (let i = 0; i < count; i++) {
      this.h264.addFrameYuv(yuv)
    }
  },

  finish() {
    if (this.gif) {
      this.gif.finish()

      return toBase64(this.gif.bytes())
    }

    this.h264.finalize()

    const bytes = this.h264.FS.readFile(this.h264.outputFilename)

    this.h264.FS.unlink(this.h264.outputFilename)
    this.h264.delete()

    return toBase64(bytes)
  },
}
