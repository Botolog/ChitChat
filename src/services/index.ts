import { EventEmitter } from "events"
import { logger } from "../utils/logger"
import type { ChatData, MessageData, ContactData } from "./whatsapp"

// Re-export types
export type { ChatData, MessageData, ContactData }

// Unified service interface
export interface MessagingService extends EventEmitter {
  initialize(...args: any[]): Promise<void>
  isReady(): boolean
  getChats(): Promise<ChatData[]>
  getMessages(chatId: string, limit?: number): Promise<MessageData[]>
  sendMessage(chatId: string, content: string, options?: { replyTo?: string }): Promise<MessageData | null>
  deleteMessage(messageId: string, chatId: string, forMe: boolean): Promise<boolean>
  editMessage(messageId: string, chatId: string, newText: string): Promise<boolean>
  markAsRead(chatId: string): Promise<void>
  pinChat(chatId: string, pin: boolean): Promise<boolean>
  muteChat(chatId: string, mute: boolean): Promise<boolean>
  archiveChat(chatId: string, archive: boolean): Promise<boolean>
  getContactInfo(contactId: string): Promise<ContactData | null>
  destroy(): Promise<void>
  getConnectionState(): { ready: boolean; hasQr: boolean }
  /**
   * Render a QR payload into a printable string (block characters) for the TUI
   * to display itself. Implementations must NOT write to stdout: the TUI owns
   * the terminal, so anything printed there is overwritten and never seen.
   */
  renderQrCode?(qr: string): string
}

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
