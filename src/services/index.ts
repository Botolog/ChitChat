import { logger } from "../utils/logger"
import type { MessagingService } from "./types"

// Re-export the shared contract for convenience.
export type {
  MessagingService,
  ChatData,
  MessageData,
  ContactData,
  MediaAttachment,
  ConnectionState,
  SendMessageOptions,
  TypingPayload,
} from "./types"
export type { ServiceCapabilities } from "./capabilities"

/** Service instances cache, keyed by service id. */
const serviceInstances: Map<string, MessagingService> = new Map()

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Load (or return the cached) service instance for `serviceId`.
 *
 * Returns `null` for unknown or not-yet-implemented services instead of
 * throwing, so the UI can surface a friendly message.
 */
export async function getServiceInstance(serviceId: string): Promise<MessagingService | null> {
  // Return cached instance if exists
  const cached = serviceInstances.get(serviceId)
  if (cached) {
    return cached
  }

  logger.info("ServiceManager", "Loading service", { serviceId })

  try {
    let service: MessagingService | null = null

    switch (serviceId) {
      case "whatsapp": {
        const { whatsapp } = await import("./whatsapp")
        service = whatsapp
        break
      }
      case "slack": {
        const { slack } = await import("./slack")
        service = slack
        break
      }
      case "discord":
      case "telegram":
      case "signal":
      case "matrix":
        logger.warn("ServiceManager", "Service not yet implemented", { serviceId })
        return null
      default:
        logger.error("ServiceManager", "Unknown service", { serviceId })
        return null
    }

    serviceInstances.set(serviceId, service)
    logger.info("ServiceManager", "Service loaded", { serviceId })
    return service
  } catch (err) {
    logger.error("ServiceManager", "Failed to load service", {
      serviceId,
      error: errorMessage(err),
    })
    return null
  }
}

export function getCachedService(serviceId: string): MessagingService | null {
  return serviceInstances.get(serviceId) ?? null
}

export async function destroyService(serviceId: string): Promise<void> {
  const service = serviceInstances.get(serviceId)
  if (service) {
    await service.destroy()
    serviceInstances.delete(serviceId)
    logger.info("ServiceManager", "Service destroyed", { serviceId })
  }
}

export async function destroyAllServices(): Promise<void> {
  for (const [id, service] of serviceInstances) {
    try {
      await service.destroy()
      logger.info("ServiceManager", "Service destroyed", { serviceId: id })
    } catch (err) {
      logger.error("ServiceManager", "Error destroying service", {
        serviceId: id,
        error: errorMessage(err),
      })
    }
  }
  serviceInstances.clear()
}
