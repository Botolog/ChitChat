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

// Service instances cache
const serviceInstances: Map<string, MessagingService> = new Map()

export async function getServiceInstance(serviceId: string): Promise<MessagingService | null> {
  // Return cached instance if exists
  if (serviceInstances.has(serviceId)) {
    return serviceInstances.get(serviceId)!
  }

  logger.info("ServiceManager", "Loading service", { serviceId })

  try {
    let service: MessagingService | null = null

    switch (serviceId) {
      case "whatsapp": {
        const { whatsapp } = await import("./whatsapp")
        service = whatsapp as unknown as MessagingService
        break
      }
      case "slack": {
        const { slack } = await import("./slack")
        service = slack as unknown as MessagingService
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

    if (service) {
      serviceInstances.set(serviceId, service)
      logger.info("ServiceManager", "Service loaded", { serviceId })
    }

    return service
  } catch (err: any) {
    logger.error("ServiceManager", "Failed to load service", { serviceId, error: err.message })
    return null
  }
}

export function getCachedService(serviceId: string): MessagingService | null {
  return serviceInstances.get(serviceId) || null
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
    } catch (err: any) {
      logger.error("ServiceManager", "Error destroying service", { serviceId: id, error: err.message })
    }
  }
  serviceInstances.clear()
}
