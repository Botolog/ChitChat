import type { CliRenderer } from "@opentui/core"
import type { AppSettings } from "../settings"
import type { KeyBindings } from "../keybindings"
import type { MessagingService } from "../services/types"
import type { ServiceConfig } from "../services/registry"
import type { MediaRenderer } from "../utils/mediaRenderer"
import type { MediaServer } from "../utils/mediaServer"
import type { TerminalCapabilities } from "../utils/terminalCapabilities"
import type { AppState } from "./state"
import type { ThemeManager } from "./theme"
import type { Lifecycle } from "./lifecycle"
import type { LayoutHandles } from "../ui/layout"
import type { StatusBar } from "../ui/statusBar"
import type { ConfirmModal } from "../ui/modals/confirmModal"
import type { QrModal } from "../ui/modals/qrModal"

/** Mutable geometry shared by the resize handler and the renderers. */
export interface Dimensions {
  width: number
  height: number
  chatListWidth: number
  msgAreaWidth: number
}

/** Immutable-ish configuration resolved once at bootstrap. */
export interface AppConfig {
  demoMode: boolean
  settings: AppSettings
  keybindings: KeyBindings
  services: ServiceConfig[]
  termCapabilities: TerminalCapabilities
}

/** The active messaging service slot. */
export interface ServiceSlot {
  active: MessagingService | null
  activeId: string | null
}

/** Media subsystem handles. */
export interface MediaSlot {
  renderer: MediaRenderer | null
  server: MediaServer
}

/**
 * The single shared application context passed to every module.
 *
 * It replaces the ~40 free closure variables that used to live inside `main()`;
 * modules receive it and mutate `state`/`handles` rather than closing over
 * locals.
 */
export interface AppContext {
  renderer: CliRenderer
  dims: Dimensions
  state: AppState
  handles: LayoutHandles
  theme: ThemeManager
  config: AppConfig
  service: ServiceSlot
  lifecycle: Lifecycle
  status: StatusBar
  media: MediaSlot
  confirm: ConfirmModal
  qr: QrModal
  /** Graceful shutdown (assigned by `bootstrap.ts`). */
  shutdown: (code: number) => Promise<void>
}
