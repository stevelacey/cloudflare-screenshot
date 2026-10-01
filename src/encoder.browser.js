const toBase64 = (bytes) => {
  let binary = ""

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }

  return btoa(binary)
}

const byte = (value) => Math.min(255, Math.max(0, Math.round(value)))

// The bundled encoder converts with BT.601, which shifts colours
const toYuv = (rgba, width, height) => {
  const yuv = new Uint8Array((width * height * 3) / 2)
  const u = width * height
  const v = u + u / 4

  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]

    yuv[i] = byte(16 + ((0.2126 * r + 0.7152 * g + 0.0722 * b) * 219) / 255)
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

      yuv[u + j] = byte(128 + ((b - luma) / 1.8556) * (224 / 255))
      yuv[v + j] = byte(128 + ((r - luma) / 1.5748) * (224 / 255))
    }
  }

  return yuv
}

const decode = (data) => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  return bytes
}

window.__encoder = {
  async start({ format, width, height, fps }) {
    this.fps = fps

    if (format === "gif") {
      this.gif = window.__gifenc.GIFEncoder()
    } else {
      this.h264 = await window.HME.createH264MP4Encoder()
      Object.assign(this.h264, { width, height, frameRate: fps, quantizationParameter: 10, speed: 0, groupOfPictures: fps * 2 })
      this.h264.initialize()
    }

    this.canvas = new OffscreenCanvas(width, height)
    this.context = this.canvas.getContext("2d", { willReadFrequently: true })
  },

  async add(data, count) {
    const bitmap = await createImageBitmap(new Blob([decode(data)], { type: "image/png" }))

    this.context.drawImage(bitmap, 0, 0)
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
