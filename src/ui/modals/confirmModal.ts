import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { logger } from "../../utils/logger"

/** The persistent, hidden modal renderables (built once by `layout.ts`). */
export interface ConfirmModalHandles {
  overlay: BoxRenderable
  title: TextRenderable
  message: TextRenderable
  options: TextRenderable
}

/** Visibility the modal must save/restore around itself. */
export interface ViewBoxes {
  mainBox: BoxRenderable
  menuBox: BoxRenderable
  settingsBox: BoxRenderable
}

/** The default prompt chrome, restored whenever the modal is (re)used. */
const DEFAULT_TITLE = "⚠️  Confirm Delete"
const DEFAULT_OPTIONS = "[Y] Yes  [N] No  [Esc] Cancel"
const KEY_CAPTURE_OPTIONS = ""

/** Build the confirm-modal renderables (added to the root by `layout.ts`). */
export function createConfirmModal(
  renderer: CliRenderer,
  width: number,
  height: number,
): ConfirmModalHandles {
  const overlay = new BoxRenderable(renderer, {
    id: "confirm-modal-overlay",
    width,
    height,
    backgroundColor: "#0D1117",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    visible: false,
  })

  const title = new TextRenderable(renderer, {
    id: "confirm-modal-title",
    content: DEFAULT_TITLE,
    fg: "#F15C6D",
  })

  const spacer1 = new TextRenderable(renderer, {
    id: "confirm-modal-spacer1",
    content: " ",
    fg: "#8B949E",
  })

  const message = new TextRenderable(renderer, {
    id: "confirm-modal-message",
    content: "",
    fg: "#C9D1D9",
  })

  const spacer2 = new TextRenderable(renderer, {
    id: "confirm-modal-spacer2",
    content: " ",
    fg: "#8B949E",
  })

  const options = new TextRenderable(renderer, {
    id: "confirm-modal-options",
    content: DEFAULT_OPTIONS,
    fg: "#6E7681",
  })

  overlay.add(title)
  overlay.add(spacer1)
  overlay.add(message)
  overlay.add(spacer2)
  overlay.add(options)

  return { overlay, title, message, options }
}

/**
 * Confirm (Y/N) modal.
 *
 * The same overlay is also reused for keybinding key-capture (title/options
 * swapped). T3: `show()` and `hide()` always reset the title/options so a stale
 * key-capture prompt can never leak into a later confirm.
 */
export class ConfirmModal {
  private visible = false
  private capturing = false
  private callback: ((confirmed: boolean) => void) | null = null

  private prevMain = false
  private prevMenu = false
  private prevSettings = false

  constructor(
    private readonly handles: ConfirmModalHandles,
    private readonly boxes: ViewBoxes,
  ) {}

  get isVisible(): boolean {
    return this.visible
  }

  get isCapturing(): boolean {
    return this.capturing
  }

  /** Reset title/options to the confirm chrome. */
  reset(): void {
    this.handles.title.content = DEFAULT_TITLE
    this.handles.options.content = DEFAULT_OPTIONS
  }

  show(message: string, callback: (confirmed: boolean) => void): void {
    this.reset()
    this.handles.message.content = message
    this.callback = callback
    this.visible = true

    this.prevMain = this.boxes.mainBox.visible
    this.prevMenu = this.boxes.menuBox.visible
    this.prevSettings = this.boxes.settingsBox.visible

    this.boxes.mainBox.visible = false
    this.boxes.menuBox.visible = false
    this.boxes.settingsBox.visible = false
    this.handles.overlay.visible = true

    logger.info("App", "Showing confirmation modal", {
      message,
      overlayVisible: this.handles.overlay.visible,
      modalVisible: this.visible,
    })
  }

  hide(): void {
    this.visible = false
    this.handles.overlay.visible = false
    this.callback = null

    this.boxes.mainBox.visible = this.prevMain
    this.boxes.menuBox.visible = this.prevMenu
    this.boxes.settingsBox.visible = this.prevSettings

    this.reset()
    logger.info("App", "Hiding confirmation modal")
  }

  /** Reuse the overlay for keybinding capture (does not touch visibility state). */
  beginCapture(title: string, message: string): void {
    this.handles.title.content = title
    this.handles.message.content = message
    this.handles.options.content = KEY_CAPTURE_OPTIONS
    this.handles.overlay.visible = true
    this.capturing = true
  }

  /** Close a key-capture session and reset the chrome. */
  endCapture(): void {
    this.capturing = false
    this.handles.overlay.visible = false
    this.reset()
  }

  /**
   * Handle a key while the modal is visible.
   * @returns `true` when the key was consumed (always, while visible).
   */
  handleKey(name: string): boolean {
    if (!this.visible || !this.callback) return false
    if (name === "y" || name === "Y") {
      logger.info("App", "Confirmation modal: YES")
      this.callback(true)
      return true
    }
    if (name === "n" || name === "N" || name === "escape") {
      logger.info("App", "Confirmation modal: NO")
      this.callback(false)
      return true
    }
    // Ignore all other keys while the modal is visible.
    return true
  }
}
