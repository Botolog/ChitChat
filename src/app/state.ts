import type { ChatData, MessageData } from "../services/types"

/** Top-level view the app is currently showing. */
export type AppView = "main_menu" | "service"

/** Which panel currently owns the keyboard focus. */
export type FocusArea = "chats" | "input" | "settings" | "messages" | "editing"

/**
 * Every mutable field that used to be a free `let` inside `main()`.
 *
 * Kept as plain data (no renderables, no functions) so it can be created before
 * the renderer exists and inspected by tests.
 */
export interface AppState {
  view: AppView
  currentServiceId: string | null

  /** Currently known chats (demo fixtures initially in demo mode). */
  chats: ChatData[]
  /** Messages for `currentChatId`. */
  messages: MessageData[]

  selectedChat: number
  /** `-1` means the message cursor is hidden. */
  selectedMessage: number
  currentChatId: string | null
  focusArea: FocusArea
  isReady: boolean
  replyToMessageId: string | null
  editingMessageId: string | null

  showSettings: boolean
  settingsSection: number
  settingsItem: number
  /** Index into `SETTINGS_PAGES`. */
  currentSettingsPage: number

  menuSelectedIndex: number

  keyCaptureActive: boolean
  keyCaptureKeybindingKey: string | null
  keyCaptureLabel: string
}

/** Build the initial state. `chats` is passed in so demo fixtures are shared. */
export function createInitialState(demoMode: boolean, chats: ChatData[]): AppState {
  return {
    view: "main_menu",
    currentServiceId: null,
    chats: demoMode ? chats : [],
    messages: [],
    selectedChat: 0,
    selectedMessage: -1,
    currentChatId: null,
    focusArea: "chats",
    isReady: demoMode,
    replyToMessageId: null,
    editingMessageId: null,
    showSettings: false,
    settingsSection: 0,
    settingsItem: 0,
    currentSettingsPage: 0,
    menuSelectedIndex: 0,
    keyCaptureActive: false,
    keyCaptureKeybindingKey: null,
    keyCaptureLabel: "",
  }
}
