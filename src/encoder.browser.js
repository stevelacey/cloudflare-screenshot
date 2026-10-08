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

const fourcc = (type) => Uint8Array.from(type, (char) => char.charCodeAt(0))

const uint = (value, bytes) => Uint8Array.from({ length: bytes }, (_, i) => (value >> (i * 8)) & 0xff)

const join = (parts) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }

  return output
}

const chunk = (type, ...parts) => {
  const data = join(parts)

  return join([fourcc(type), uint(data.length, 4), data, new Uint8Array(data.length % 2)])
}

// Wraps each frame's still WebP chunks into an animation that loops forever
const animate = (frames, width, height) => {
  const images = frames.map(({ data, duration }) => {
    const chunks = []

    for (let offset = 12; offset < data.length; ) {
      const size = new DataView(data.buffer, data.byteOffset + offset + 4).getUint32(0, true)

      chunks.push({ type: String.fromCharCode(...data.subarray(offset, offset + 4)), bytes: data.subarray(offset, offset + 8 + size + (size % 2)) })
      offset += 8 + size + (size % 2)
    }

    // Frames may only hold image data; Chrome also adds a header and an sRGB profile
    return { chunks: chunks.filter(({ type }) => ["ALPH", "VP8 ", "VP8L"].includes(type)), duration }
  })
  const alpha = images.some(({ chunks }) => chunks.some(({ type }) => type === "ALPH"))
  const size = [uint(width - 1, 3), uint(height - 1, 3)]
  const body = join([
    fourcc("WEBP"),
    chunk("VP8X", uint(alpha ? 0x12 : 0x02, 4), ...size),
    chunk("ANIM", uint(0, 4), uint(0, 2)),
    ...images.map(({ chunks, duration }) =>
      chunk("ANMF", uint(0, 3), uint(0, 3), ...size, uint(duration, 3), uint(0x02, 1), ...chunks.map(({ bytes }) => bytes)),
    ),
  ])

  return join([fourcc("RIFF"), uint(body.length, 4), body])
}

window.__encoder = {
  async start({ format, width, height, fps, quality }) {
    this.fps = fps
    this.quality = quality
    this.elapsed = 0

    if (format === "gif") {
      this.gif = window.__gifenc.GIFEncoder()
    } else if (format === "webp") {
      this.webp = []
    } else {
      this.h264 = await window.HME.createH264MP4Encoder()
      // Quality 100 is a quantizer of 10, which is near lossless, rising to 50 at quality 0
      const quantizationParameter = Math.round(10 + (100 - quality) * 0.4)
      Object.assign(this.h264, { width, height, frameRate: fps, quantizationParameter, speed: 0, groupOfPictures: fps * 2 })
      this.h264.initialize()
    }

    this.canvas = new OffscreenCanvas(width, height)
    this.context = this.canvas.getContext("2d", { alpha: false, willReadFrequently: true })
  },

  async add(data, count) {
    const bitmap = await createImageBitmap(new Blob([decode(data)], { type: "image/png" }))
    // Whole milliseconds that add up to the true running time
    const duration = Math.round(((this.elapsed + count) * 1000) / this.fps) - Math.round((this.elapsed * 1000) / this.fps)

    this.elapsed += count

    this.context.drawImage(bitmap, 0, 0)
    bitmap.close()

    if (this.webp) {
      const blob = await this.canvas.convertToBlob({ type: "image/webp", quality: this.quality / 100 })

      this.webp.push({ data: new Uint8Array(await blob.arrayBuffer()), duration })

      return
    }

    const { width, height } = this.canvas
    const { data: rgba } = this.context.getImageData(0, 0, width, height)

    if (this.gif) {
      const { quantize, applyPalette } = window.__gifenc

      const palette = quantize(rgba, 256)

      this.gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay: duration })

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

    if (this.webp) {
      return toBase64(animate(this.webp, this.canvas.width, this.canvas.height))
    }

    this.h264.finalize()

    const bytes = this.h264.FS.readFile(this.h264.outputFilename)

    this.h264.FS.unlink(this.h264.outputFilename)
    this.h264.delete()

    return toBase64(bytes)
  },
}
