import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { logger } from "../../utils/logger"
import type { ViewBoxes } from "./confirmModal"

/** Persistent QR-modal renderables (built once by `layout.ts`). */
export interface QrModalHandles {
  overlay: BoxRenderable
  title: TextRenderable
  hint: TextRenderable
  code: TextRenderable
  footer: TextRenderable
}

const TITLE = "📱 Scan this QR code with WhatsApp"
const HINT = "WhatsApp → Settings → Linked devices → Link a device"
const FOOTER = "Waiting for you to scan… (Esc to hide)"

/** Build the QR-modal renderables (added to the root by `layout.ts`). */
export function createQrModal(
  renderer: CliRenderer,
  width: number,
  height: number,
  accent: string,
): QrModalHandles {
  const overlay = new BoxRenderable(renderer, {
    id: "qr-modal-overlay",
    width,
    height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    visible: false,
  })

  const title = new TextRenderable(renderer, {
    id: "qr-modal-title",
    content: TITLE,
    fg: accent,
  })

  const hint = new TextRenderable(renderer, {
    id: "qr-modal-hint",
    content: HINT,
    fg: "#8B949E",
  })

  const code = new TextRenderable(renderer, {
    id: "qr-modal-code",
    content: "",
    fg: "#FFFFFF",
  })

  const footer = new TextRenderable(renderer, {
    id: "qr-modal-footer",
    content: "",
    fg: "#6E7681",
  })

  overlay.add(title)
  overlay.add(hint)
  overlay.add(code)
  overlay.add(footer)

  return { overlay, title, hint, code, footer }
}

/**
 * QR-code modal shown while WhatsApp waits for authentication.
 *
 * T2: the previous implementation always hid `settingsBox` but only remembered
 * `mainBox`/`menuBox`, so closing the modal from the settings view left the
 * settings screen invisible. We now save and restore all three view boxes.
 */
export class QrModal {
  private visible = false
  private prevMain = false
  private prevMenu = false
  private prevSettings = false

  constructor(
    private readonly handles: QrModalHandles,
    private readonly boxes: ViewBoxes,
  ) {}

  get isVisible(): boolean {
    return this.visible
  }

  show(qrText: string): void {
    this.handles.title.content = TITLE
    this.handles.hint.content = HINT
    this.handles.code.content = qrText
    this.handles.footer.content = FOOTER

    this.prevMain = this.boxes.mainBox.visible
    this.prevMenu = this.boxes.menuBox.visible
    this.prevSettings = this.boxes.settingsBox.visible

    this.boxes.mainBox.visible = false
    this.boxes.menuBox.visible = false
    this.boxes.settingsBox.visible = false

    this.visible = true
    this.handles.overlay.visible = true
    logger.info("App", "Showing QR modal", { lines: qrText.split("\n").length })
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.handles.overlay.visible = false

    this.boxes.mainBox.visible = this.prevMain
    this.boxes.menuBox.visible = this.prevMenu
    this.boxes.settingsBox.visible = this.prevSettings
    logger.info("App", "Hiding QR modal")
  }
}
