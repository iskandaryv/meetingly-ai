import { desktopCapturer, screen } from "electron"

export interface Capture {
  base64: string
  width: number
  height: number
  bytes: number
}

const MAX_WIDTH = 1280
const MAX_HEIGHT = 800
const JPEG_QUALITY = 70
const MAX_BYTES = 350 * 1024

/**
 * Grab the primary display as a JPEG small enough for a vision model.
 * The caller hides its own windows first when content protection is off.
 */
export async function captureScreen(): Promise<Capture> {
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale)
    }
  })
  const primary = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!primary || primary.thumbnail.isEmpty()) throw new Error("Screen capture returned an empty image")

  const size = primary.thumbnail.getSize()
  const ratio = Math.min(1, MAX_WIDTH / size.width, MAX_HEIGHT / size.height)
  const width = Math.round(size.width * ratio)
  const height = Math.round(size.height * ratio)
  const resized = ratio < 1 ? primary.thumbnail.resize({ width, height, quality: "good" }) : primary.thumbnail

  let quality = JPEG_QUALITY
  let jpeg = resized.toJPEG(quality)
  while (jpeg.length > MAX_BYTES && quality > 35) {
    quality -= 10
    jpeg = resized.toJPEG(quality)
  }
  return { base64: jpeg.toString("base64"), width, height, bytes: jpeg.length }
}
