import { appendFileSync, writeFileSync } from "fs"

function timestamp(): string {
  return new Date().toISOString()
}

function formatMessage(level: string, context: string, message: string, data?: any): string {
  let line = `[${timestamp()}] [${level}] [${context}] ${message}`
  if (data !== undefined) {
    try {
      line += ` | ${JSON.stringify(data)}`
    } catch {
      line += ` | [Circular or non-serializable data]`
    }
  }
  return line + "\n"
}

export class Logger {
  private logFile: string

  constructor(logFile: string, serviceName: string = "Service") {
    this.logFile = logFile
    this.init(serviceName)
  }

  private init(serviceName: string) {
    writeFileSync(this.logFile, `=== ${serviceName} Log Started ${timestamp()} ===\n`)
  }

  info(context: string, message: string, data?: any) {
    const line = formatMessage("INFO", context, message, data)
    appendFileSync(this.logFile, line)
  }

  warn(context: string, message: string, data?: any) {
    const line = formatMessage("WARN", context, message, data)
    appendFileSync(this.logFile, line)
  }

  error(context: string, message: string, error?: any) {
    let errorData: any = undefined
    if (error) {
      if (error instanceof Error) {
        errorData = {
          message: error.message,
          stack: error.stack,
          name: error.name,
        }
      } else if (typeof error === "object") {
        // Puppeteer/whatsapp-web.js sometimes throw plain objects, and callers
        // sometimes wrap an Error in a metadata object. JSON stringify with a
        // replacer so the real content is visible in the log instead of the
        // useless "[object Object]".
        let serialized: any
        try {
          serialized = JSON.parse(
            JSON.stringify(error, (_key, value) =>
              value instanceof Error
                ? { name: value.name, message: value.message, stack: value.stack }
                : value
            )
          )
        } catch {
          serialized = String(error)
        }
        errorData = (error as any).message !== undefined
          ? { message: (error as any).message, name: (error as any).name }
          : serialized
      } else {
        errorData = { message: String(error) }
      }
    }
    const line = formatMessage("ERROR", context, message, errorData)
    appendFileSync(this.logFile, line)
  }

  debug(context: string, message: string, data?: any) {
    const line = formatMessage("DEBUG", context, message, data)
    appendFileSync(this.logFile, line)
  }

  event(context: string, eventName: string, data?: any) {
    const line = formatMessage("EVENT", context, `Event: ${eventName}`, data)
    appendFileSync(this.logFile, line)
  }
}

// Default logger instance for backward compatibility
export const logger = new Logger("chitchat.log", "ChitChat")
