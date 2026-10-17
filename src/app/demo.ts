import type { ChatData, MessageData } from "../services/types"

/**
 * Demo fixtures for `--demo` mode.
 *
 * These were extracted verbatim from `src/index.ts` (same ids, names, bodies and
 * fields) so the TUI can import them instead of inlining ~40 lines of data.
 * Timestamps are relative to module load (`Date.now()`), matching the original
 * inline definition.
 */

/** A demo chat with a guaranteed last-message preview. */
export interface DemoChat extends ChatData {
  lastMessage: { body: string; timestamp: number; fromMe: boolean }
}

/** A demo message (same shape as a real one; media attachments are omitted). */
export interface DemoMessage extends MessageData {}

const DEMO_CHAT_FIXTURES: DemoChat[] = [
  { id: "1", name: "John Doe", isGroup: false, unreadCount: 2, pinned: true, muted: false, archived: false, lastMessage: { body: "Hey, how are you?", timestamp: Date.now() / 1000, fromMe: false } },
  { id: "2", name: "Jane Smith", isGroup: false, unreadCount: 0, pinned: false, muted: false, archived: false, lastMessage: { body: "See you tomorrow!", timestamp: Date.now() / 1000 - 3600, fromMe: true } },
  { id: "3", name: "Work Group", isGroup: true, unreadCount: 5, pinned: false, muted: false, archived: false, participantCount: 12, lastMessage: { body: "Meeting at 3pm", timestamp: Date.now() / 1000 - 7200, fromMe: false } },
  { id: "4", name: "Family", isGroup: true, unreadCount: 0, pinned: false, muted: true, archived: false, participantCount: 8, lastMessage: { body: "Happy birthday! 🎂", timestamp: Date.now() / 1000 - 86400, fromMe: false } },
  { id: "5", name: "Bob Wilson", isGroup: false, unreadCount: 1, pinned: false, muted: false, archived: false, lastMessage: { body: "Thanks for the help!", timestamp: Date.now() / 1000 - 172800, fromMe: false } },
]

const DEMO_MESSAGE_FIXTURES: Record<string, DemoMessage[]> = {
  "1": [
    { id: "m1", body: "Hey there! 👋", timestamp: Date.now() / 1000 - 300, fromMe: false, hasMedia: false, type: "chat", ack: 3 },
    { id: "m2", body: "Hi! How are you doing?", timestamp: Date.now() / 1000 - 240, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "I'm good! Working on that project.", timestamp: Date.now() / 1000 - 180, fromMe: false, hasMedia: false, type: "chat", ack: 3, isStarred: true },
    { id: "m4", body: "Let me know if you need help!", timestamp: Date.now() / 1000 - 120, fromMe: true, hasMedia: false, type: "chat", ack: 2 },
    { id: "m5", body: "Hey, how are you?", timestamp: Date.now() / 1000 - 60, fromMe: false, hasMedia: false, type: "chat", ack: 0, hasQuotedMsg: true, quotedMsgBody: "Let me know if you need help!", quotedMsgId: "m4" },
  ],
  "2": [
    { id: "m1", body: "Are you coming to the party?", timestamp: Date.now() / 1000 - 7200, fromMe: false, hasMedia: false, type: "chat", ack: 3 },
    { id: "m2", body: "Yes! What time?", timestamp: Date.now() / 1000 - 7000, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "8pm at my place", timestamp: Date.now() / 1000 - 6800, fromMe: false, hasMedia: false, type: "chat", ack: 3, isStarred: true },
    { id: "m4", body: "See you tomorrow!", timestamp: Date.now() / 1000 - 3600, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
  ],
  "3": [
    { id: "m1", body: "Team, don't forget the meeting", timestamp: Date.now() / 1000 - 10000, fromMe: false, authorName: "Boss", hasMedia: false, type: "chat", ack: 3, isForwarded: true },
    { id: "m2", body: "I'll be there", timestamp: Date.now() / 1000 - 9000, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "Same here 👍", timestamp: Date.now() / 1000 - 8500, fromMe: false, authorName: "Alice", hasMedia: false, type: "chat", ack: 3, hasQuotedMsg: true, quotedMsgBody: "Team, don't forget the meeting", quotedMsgId: "m1" },
    { id: "m4", body: "Meeting at 3pm", timestamp: Date.now() / 1000 - 7200, fromMe: false, authorName: "Boss", hasMedia: false, type: "chat", ack: 3, isStarred: true },
  ],
  "4": [
    { id: "m1", body: "Happy birthday! 🎂🎉", timestamp: Date.now() / 1000 - 90000, fromMe: false, authorName: "Mom", hasMedia: false, type: "chat", ack: 3, isForwarded: true, forwardingScore: 5 },
    { id: "m2", body: "Thanks everyone!", timestamp: Date.now() / 1000 - 89000, fromMe: true, hasMedia: false, type: "chat", ack: 3 },
    { id: "m3", body: "🎈🎁", timestamp: Date.now() / 1000 - 88000, fromMe: false, authorName: "Dad", hasMedia: false, type: "chat", ack: 3 },
  ],
  "5": [
    { id: "m1", body: "Can you help me with the code?", timestamp: Date.now() / 1000 - 200000, fromMe: false, hasMedia: false, type: "chat", ack: 3 },
    { id: "m2", body: "Sure, what's the issue?", timestamp: Date.now() / 1000 - 199000, fromMe: true, hasMedia: false, type: "chat", ack: 3, hasQuotedMsg: true, quotedMsgBody: "Can you help me with the code?", quotedMsgId: "m1" },
    { id: "m3", body: "", timestamp: Date.now() / 1000 - 198000, fromMe: false, hasMedia: true, type: "image", ack: 3 },
    { id: "m4", body: "", timestamp: Date.now() / 1000 - 197000, fromMe: true, hasMedia: true, type: "document", ack: 3 },
    { id: "m5", body: "", timestamp: Date.now() / 1000 - 196000, fromMe: false, hasMedia: true, type: "ptt", ack: 3 },
    { id: "m6", body: "I fixed it, thanks!", timestamp: Date.now() / 1000 - 172800, fromMe: false, hasMedia: false, type: "chat", ack: 3, isStarred: true },
  ],
}

/** The five demo chats shown in `--demo` mode. */
export const DEMO_CHATS: ChatData[] = DEMO_CHAT_FIXTURES

/** Demo message history keyed by chat id. */
export const DEMO_MESSAGES: Record<string, MessageData[]> = DEMO_MESSAGE_FIXTURES
