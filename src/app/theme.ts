import { getServiceTheme, type ServiceTheme } from "../services/registry"
import { logger } from "../utils/logger"

/**
 * Owns the active colour palette.
 *
 * The palette is derived from the selected service (`getServiceTheme`) and read
 * by the UI modules through `ctx.theme.colors`; it is never cached globally so a
 * service switch immediately affects subsequent renders.
 */
export class ThemeManager {
  private palette: ServiceTheme

  constructor(initialServiceId: string = "whatsapp") {
    this.palette = getServiceTheme(initialServiceId)
  }

  /** The active palette. */
  get colors(): ServiceTheme {
    return this.palette
  }

  /** Switch to a service's palette and return it. */
  setServiceTheme(serviceId: string): ServiceTheme {
    this.palette = getServiceTheme(serviceId)
    logger.info("App", "Theme changed", { serviceId, primary: this.palette.primary })
    return this.palette
  }
}
