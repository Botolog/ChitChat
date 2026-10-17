import QRCode from "qrcode"

export interface RenderQrOptions {
  /** Quiet-zone width in modules (padding around the code). Default 2. */
  border?: number
  /** Error-correction level. Default "L" produces the smallest code. */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H"
}

/**
 * Render a QR payload to a block-character string suitable for display inside a
 * TUI (e.g. an OpenTUI TextRenderable).
 *
 * Uses half-block characters so two module rows are packed into one text row
 * (the most compact representation that stays scannable). Returns plain text
 * with no ANSI escapes, and never writes to stdout.
 *
 * Rendering convention: light modules become filled blocks (foreground) and
 * dark modules stay as background, which yields a standard dark-on-light QR on
 * a dark terminal palette.
 */
export function renderQrBlocks(text: string, options: RenderQrOptions = {}): string {
  const border = Math.max(0, options.border ?? 2)
  const errorCorrectionLevel = options.errorCorrectionLevel ?? "L"

  const qr = QRCode.create(text, { errorCorrectionLevel })
  const size = qr.modules.size
  const total = size + border * 2

  const isDark = (row: number, col: number): boolean => {
    const r = row - border
    const c = col - border
    if (r < 0 || c < 0 || r >= size || c >= size) return false
    return qr.modules.get(r, c) !== 0
  }

  const lines: string[] = []
  for (let y = 0; y < total; y += 2) {
    let line = ""
    for (let x = 0; x < total; x++) {
      const topLight = !isDark(y, x)
      const bottomLight = y + 1 < total ? !isDark(y + 1, x) : false
      line += topLight && bottomLight ? "█" : topLight ? "▀" : bottomLight ? "▄" : " "
    }
    lines.push(line)
  }
  return lines.join("\n")
}
