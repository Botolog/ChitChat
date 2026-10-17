/**
 * Declares what a messaging backend can actually do, so the UI can adapt
 * instead of calling unsupported methods and crashing.
 */
export interface ServiceCapabilities {
  /** Backend authenticates via a scannable QR code. */
  qrAuth: boolean
  /** Message deletion support level. */
  deleteMessage: "none" | "forMe" | "forEveryone" | "both"
  editMessage: boolean
  pin: boolean
  mute: boolean
  archive: boolean
  downloadMedia: boolean
  reply: boolean
}

/** Capabilities for a backend that supports nothing optional. */
export const NO_CAPABILITIES: ServiceCapabilities = {
  qrAuth: false,
  deleteMessage: "none",
  editMessage: false,
  pin: false,
  mute: false,
  archive: false,
  downloadMedia: false,
  reply: false,
}
