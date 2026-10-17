/**
 * Minimal WhatsApp Web test - no GUI, just Puppeteer debugging
 * Run: ~/.bun/bin/bun run src/test-whatsapp.ts
 */

import pkg from "whatsapp-web.js"
const { Client, LocalAuth } = pkg
import { renderQrBlocks } from "./utils/qr"
import { collectWhatsAppChats } from "./utils/whatsappChats"
import { installWhatsAppCompat } from "./utils/whatsappCompat"
import { appendFileSync, writeFileSync } from "fs"

const LOG_FILE = "whatsapp-test.log"

function log(level: string, msg: string, data?: any) {
  const ts = new Date().toISOString()
  let line = `[${ts}] [${level}] ${msg}`
  if (data) {
    try {
      line += ` | ${JSON.stringify(data)}`
    } catch {
      line += ` | [non-serializable]`
    }
  }
  console.log(line)
  appendFileSync(LOG_FILE, line + "\n")
}

async function main() {
  writeFileSync(LOG_FILE, `=== WhatsApp Test Started ${new Date().toISOString()} ===\n`)
  
  log("INFO", "Creating WhatsApp client with verbose Puppeteer options")
  
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      dumpio: true, // Pipe browser process stdout/stderr to console
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--mute-audio",
        "--safebrowsing-disable-auto-update",
        "--disable-features=site-per-process", // May help with stability
      ],
      timeout: 120000, // 120 second timeout
    },
  })

  log("INFO", "Setting up event handlers")

  client.on("qr", (qr) => {
    log("EVENT", "QR code received", { length: qr.length })
    console.log("\n=== SCAN THIS QR CODE ===")
    console.log(renderQrBlocks(qr))
    console.log("=========================\n")
  })

  client.on("loading_screen", (percent, message) => {
    log("EVENT", "Loading screen", { percent, message })
  })

  // Poll client state every 5 seconds to see what's happening
  let stateCheckCount = 0
  const stateChecker = setInterval(async () => {
    stateCheckCount++
    try {
      const state = await client.getState()
      log("DEBUG", `State check #${stateCheckCount}:`, { state })
      
      // If we've checked 12 times (60 seconds) stop polling
      if (stateCheckCount >= 12) {
        log("INFO", "Stopping state polling after 60s")
        clearInterval(stateChecker)
      }
    } catch (err: any) {
      log("DEBUG", `State check #${stateCheckCount} failed:`, { error: err.message })
    }
  }, 5000)

  client.on("authenticated", () => {
    log("EVENT", "Authenticated successfully")
    
    // Start a timeout to manually try loading chats if ready never fires
    log("INFO", "Starting 30s timeout to manually try loading chats if ready event doesn't fire...")
    setTimeout(async () => {
      log("WARN", "=== TIMEOUT: Ready event never fired! Trying to load chats anyway... ===")
      try {
        log("INFO", "Checking client state...")
        const state = await client.getState()
        log("INFO", "Client state:", { state })
        
        log("INFO", "Attempting client.getChats() without ready event...")
        const chats = await client.getChats()
        log("INFO", `Got ${chats.length} chats WITHOUT ready event!`)
        
        if (chats.length > 0) {
          log("INFO", "First 5 chats:")
          for (let i = 0; i < Math.min(5, chats.length); i++) {
            const chat = chats[i]
            log("INFO", `  ${i + 1}. ${chat.name}`, {
              id: chat.id._serialized,
              isGroup: chat.isGroup,
              unreadCount: chat.unreadCount
            })
          }
          log("WARN", "CHATS LOADED! The ready event is broken but getChats() works!")
        } else {
          log("ERROR", "No chats returned even with manual attempt")
        }
      } catch (err: any) {
        log("ERROR", "Manual chat load failed", { message: err.message, stack: err.stack })
      }
    }, 30000)
  })

  client.on("auth_failure", (msg) => {
    log("ERROR", "Authentication failed", { message: msg })
  })

  client.on("ready", async () => {
    log("EVENT", "Client is ready!")
    console.log("\n✅ WhatsApp client is ready!\n")
    
    // TEST: Load chats using the exact same method as the GUI
    log("INFO", "=== TESTING CHAT LOADING ===")
    try {
      const pupPage = (client as any).pupPage

      // Install the same compatibility layer the app installs, so this probe
      // reproduces the app's behaviour (see utils/whatsappCompat).
      if (pupPage) {
        const compat = await pupPage.evaluate(installWhatsAppCompat)
        log("INFO", "Compatibility layer:", compat)
      }

      // Read WhatsApp's collection directly, the way the app does.
      log("INFO", "Reading WhatsApp's chat collection via collectWhatsAppChats()...")
      const chatIds: string[] = []
      if (pupPage) {
        const collected = await pupPage.evaluate(collectWhatsAppChats)
        log("INFO", "Chat collection read result:", {
          chats: collected.chats.length,
          total: collected.total,
          recovered: collected.recovered,
          skipped: collected.skipped,
          firstError: collected.firstError,
          collectionError: collected.collectionError,
        })
        log("INFO", "First 5 chats from the collection:")
        for (const chat of collected.chats.slice(0, 5)) {
          log("INFO", "  chat:", {
            id: chat.id,
            name: chat.name,
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount,
            lastMsgBody: chat.lastMessage?.body?.slice(0, 30) || "[none]",
          })
          if (typeof chat.id === "string" && chatIds.length < 3) chatIds.push(chat.id)
        }
      } else {
        log("WARN", "pupPage not available")
      }
      
      // Also try the normal method with timeout
      log("INFO", "Calling client.getChats() with 30s timeout...")
      const chatsPromise = client.getChats()
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("getChats() timed out after 30s")), 30000)
      )
      const chats = await Promise.race([chatsPromise, timeoutPromise]) as any[]
      log("INFO", `Got ${chats.length} raw chats from client`)
      
      if (chats.length === 0) {
        log("WARN", "No chats returned! This is the problem.")
      } else {
        // Print first 10 chats
        log("INFO", "First 10 chats:")
        for (let i = 0; i < Math.min(10, chats.length); i++) {
          const chat = chats[i]
          log("INFO", `  Chat ${i + 1}:`, {
            id: chat.id._serialized,
            name: chat.name,
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount,
            archived: chat.archived,
            pinned: chat.pinned,
            hasLastMessage: !!chat.lastMessage,
            lastMsgBody: chat.lastMessage?.body?.slice(0, 30) || "[none]"
          })
        }
        
        // Filter non-archived
        const filtered = chats.filter(c => !c.archived)
        log("INFO", `After filtering archived: ${filtered.length} chats`)
        
        // Sort by last message time
        const sorted = filtered.sort((a, b) => {
          const aTime = a.lastMessage?.timestamp ?? 0
          const bTime = b.lastMessage?.timestamp ?? 0
          return bTime - aTime
        })
        log("INFO", "Sorted chats (most recent first):")
        for (let i = 0; i < Math.min(5, sorted.length); i++) {
          const chat = sorted[i]
          const time = chat.lastMessage?.timestamp 
            ? new Date(chat.lastMessage.timestamp * 1000).toLocaleString()
            : "no timestamp"
          log("INFO", `  ${i + 1}. ${chat.name} (${time})`)
        }
      }

      // TEST: read messages and look a message up by id — the paths the UI uses
      // when a chat is opened, replied to, edited, deleted or has media opened.
      log("INFO", "=== TESTING MESSAGE READ ===")
      for (const chatId of chatIds) {
        try {
          const chat = await client.getChatById(chatId)
          const messages = await chat.fetchMessages({ limit: 5 })
          const firstId =
            messages[0]?.id?._serialized ?? (messages[0]?.id as any)?.$1 ?? null
          log("INFO", "getChatById + fetchMessages OK", {
            chatId,
            name: chat.name,
            messages: messages.length,
            firstMessageId: firstId,
            firstBody: messages[0]?.body?.slice(0, 30) ?? "",
          })

          if (firstId) {
            const found = await client.getMessageById(firstId)
            log("INFO", "getMessageById OK", { messageId: firstId, found: !!found })
          }
        } catch (err: any) {
          log("ERROR", "message read failed", {
            chatId,
            message: err.message,
            stack: err.stack,
          })
        }
      }

      const finalCompat = pupPage ? await pupPage.evaluate(() => (globalThis as any).__chitchatCompat ?? null) : null
      log("INFO", "Compatibility layer after tests:", finalCompat)
      log("INFO", "=== CHAT LOADING TEST COMPLETE ===")
    } catch (err: any) {
      log("ERROR", "Failed to load chats!", {
        message: err.message,
        stack: err.stack
      })
    }
  })

  client.on("disconnected", (reason) => {
    log("EVENT", "Disconnected", { reason })
  })

  client.on("change_state", (state) => {
    log("EVENT", "State changed", { state })
  })

  // Catch any unhandled errors from the client
  client.on("error", (error) => {
    log("ERROR", "Client error", { message: error.message, stack: error.stack })
  })

  log("INFO", "Calling client.initialize()")
  
  try {
    await client.initialize()
    log("INFO", "client.initialize() resolved")
    
    // Keep running
    log("INFO", "Client initialized, waiting for events... (Ctrl+C to quit)")
    
  } catch (error: any) {
    log("ERROR", "client.initialize() threw error", {
      message: error.message,
      stack: error.stack,
      name: error.name,
    })
    
    // Try to get more info
    if (error.message?.includes("Target closed")) {
      log("DEBUG", "Browser target closed - likely Chrome crash or missing dependencies")
      log("DEBUG", "Try running: google-chrome --version")
      log("DEBUG", "Or install Chrome: sudo apt install chromium-browser")
    }
    
    if (error.message?.includes("Navigation")) {
      log("DEBUG", "Navigation failed - browser may have crashed before loading page")
    }
    
    process.exit(1)
  }
}

// Handle process signals
process.on("SIGINT", () => {
  log("INFO", "Received SIGINT, shutting down...")
  process.exit(0)
})

process.on("uncaughtException", (error) => {
  log("ERROR", "Uncaught exception", { message: error.message, stack: error.stack })
})

process.on("unhandledRejection", (reason: any) => {
  log("ERROR", "Unhandled rejection", { reason: reason?.message || reason })
})

main().catch((err) => {
  log("ERROR", "main() crashed", { message: err.message, stack: err.stack })
  process.exit(1)
})
