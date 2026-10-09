import { createClient } from '@supabase/supabase-js';

// ⚠️ 务必替换成你 Supabase 里的真实数据！
const supabaseUrl = 'https://oxgdulqlecnurvxyxejx.supabase.co';
const supabaseKey = 'sb_publishable_tdP32zYlpPxDj3utaOP-Sg_JMvG4-Em';
const supabase = createClient(supabaseUrl, supabaseKey);

// 推送数据到 Supabase（后台自动上传）
async function pushToSupabase(sessions: any[]) {
  if (!sessions || sessions.length === 0) return;
  try {
    const payload = sessions.map(s => ({
      id: s.id,
      data: s,
      updated_at: new Date().toISOString()
    }));
    await supabase.from('chat_sync').upsert(payload);
    console.log('✅ 数据已同步到云端');
  } catch (err) {
    console.warn('❌ 云端同步失败:', err);
  }
}

// 从 Supabase 拉取数据（用来把手机上的数据同步到电脑）
export async function pullFromSupabase() {
  try {
    const { data, error } = await supabase.from('chat_sync').select('*');
    if (error) throw error;
    if (data && data.length > 0) {
      const sessions = data.map(item => item.data);
      await chatDb.sessions.clear();
      await chatDb.sessions.bulkPut(sessions);
      console.log('✅ 云端数据已拉取到本地');
      return true;
    }
  } catch (err) {
    console.warn('❌ 云端拉取失败:', err);
  }
  return false;
}

// lib/chat-db.ts
// IndexedDB persistence layer for chat data using Dexie.js.
// Provides async persistence behind the synchronous in-memory cache in chat-storage.ts.

import Dexie from "dexie";
import type { ChatMessage, ChatSession, ChatContact } from "./chat-storage";

// ── Database Schema ──────────────────────────────

class ChatDatabase extends Dexie {
    messages!: Dexie.Table<ChatMessage, string>;
    sessions!: Dexie.Table<ChatSession, string>;
    contacts!: Dexie.Table<ChatContact, string>;

    constructor() {
        super("AiPhoneChatDB");
        this.version(1).stores({
            messages: "id, sessionId, createdAt",
            sessions: "id, contactId",
            contacts: "id, characterId",
        });
    }
}

export const chatDb = new ChatDatabase();

// ── Initialization + Migration from localStorage ──

const LS_MESSAGES_KEY = "ai_phone_chat_messages_v1";
const LS_SESSIONS_KEY = "ai_phone_chat_sessions_v1";
const LS_CONTACTS_KEY = "ai_phone_chat_contacts_v1";
const LS_MIGRATED_FLAG = "ai_phone_idb_migrated_v1";

/**
 * Initialize IndexedDB and migrate data from localStorage if needed.
 * Returns the loaded data for the in-memory caches.
 */
export async function initChatDb(): Promise<{
    messages: ChatMessage[];
    sessions: ChatSession[];
    contacts: ChatContact[];
}> {
    if (typeof window === "undefined") {
        return { messages: [], sessions: [], contacts: [] };
    }

    const alreadyMigrated = window.localStorage.getItem(LS_MIGRATED_FLAG);

    if (!alreadyMigrated) {
        // Guard against a lost migration flag while IndexedDB still holds data.
        // The flag lives in volatile localStorage; the actual data lives in the far
        // more durable IndexedDB. The flag can disappear independently of the data
        // (e.g. clearing the "cache" data module, privacy tooling, partial eviction).
        // If we blindly "re-migrated" from now-empty localStorage we would shadow
        // real data with empty caches, and the next write would wipe IndexedDB.
        // So when IDB already has data, treat it as already migrated and reuse it.
        try {
            const existingCount =
                (await chatDb.messages.count()) +
                (await chatDb.sessions.count()) +
                (await chatDb.contacts.count());
            if (existingCount > 0) {
                window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
                const [messages, sessions, contacts] = await Promise.all([
                    chatDb.messages.toArray(),
                    chatDb.sessions.toArray(),
                    chatDb.contacts.toArray(),
                ]);
                console.log(`[ChatDB] Migration flag missing but IndexedDB has data; reusing it: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
                return { messages, sessions, contacts };
            }
        } catch (err) {
            console.warn("[ChatDB] Pre-migration IndexedDB check failed:", err);
        }

        // First run after migration: move localStorage data → IndexedDB
        try {
            const rawMessages = window.localStorage.getItem(LS_MESSAGES_KEY);
            const rawSessions = window.localStorage.getItem(LS_SESSIONS_KEY);
            const rawContacts = window.localStorage.getItem(LS_CONTACTS_KEY);

            const lsMessages: ChatMessage[] = rawMessages ? JSON.parse(rawMessages) : [];
            const lsSessions: ChatSession[] = rawSessions ? JSON.parse(rawSessions) : [];
            const lsContacts: ChatContact[] = rawContacts ? JSON.parse(rawContacts) : [];

            if (lsMessages.length > 0) {
                await chatDb.messages.bulkPut(lsMessages);
            }
            if (lsSessions.length > 0) {
                await chatDb.sessions.bulkPut(lsSessions);
            }
            if (lsContacts.length > 0) {
                await chatDb.contacts.bulkPut(lsContacts);
            }

            // Mark as migrated and remove old localStorage data
            window.localStorage.setItem(LS_MIGRATED_FLAG, "1");
            window.localStorage.removeItem(LS_MESSAGES_KEY);
            window.localStorage.removeItem(LS_SESSIONS_KEY);
            window.localStorage.removeItem(LS_CONTACTS_KEY);

            console.log(`[ChatDB] Migrated from localStorage: ${lsMessages.length} messages, ${lsSessions.length} sessions, ${lsContacts.length} contacts`);

            return { messages: lsMessages, sessions: lsSessions, contacts: lsContacts };
        } catch (err) {
            console.error("[ChatDB] Migration failed, falling back to localStorage:", err);
            // If migration fails, load from localStorage as fallback
            const fallbackMessages: ChatMessage[] = safeParse(window.localStorage.getItem(LS_MESSAGES_KEY));
            const fallbackSessions: ChatSession[] = safeParse(window.localStorage.getItem(LS_SESSIONS_KEY));
            const fallbackContacts: ChatContact[] = safeParse(window.localStorage.getItem(LS_CONTACTS_KEY));
            return { messages: fallbackMessages, sessions: fallbackSessions, contacts: fallbackContacts };
        }
    }

    // Already migrated: load from IndexedDB (retry up to 3 times on failure)
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const [messages, sessions, contacts] = await Promise.all([
                chatDb.messages.toArray(),
                chatDb.sessions.toArray(),
                chatDb.contacts.toArray(),
            ]);
            console.log(`[ChatDB] Loaded from IndexedDB: ${messages.length} messages, ${sessions.length} sessions, ${contacts.length} contacts`);
            return { messages, sessions, contacts };
        } catch (err) {
            lastErr = err;
            console.warn(`[ChatDB] Load attempt ${attempt + 1}/3 failed:`, err);
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
                try { if (!chatDb.isOpen()) await chatDb.open(); } catch {}
            }
        }
    }
    console.error("[ChatDB] All load attempts failed:", lastErr);
    throw new Error("[ChatDB] Failed to load after 3 attempts");
}

function safeParse<T>(raw: string | null): T[] {
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ── Async persistence helpers (fire-and-forget) ──

export function dbPutMessage(msg: ChatMessage): void {
    chatDb.messages.put(msg).catch(err => console.warn("[ChatDB] put message failed:", err));
}

export function dbPutMessages(msgs: ChatMessage[]): void {
    chatDb.messages.bulkPut(msgs).catch(err => console.warn("[ChatDB] bulkPut messages failed:", err));
}

export function dbDeleteMessage(id: string): void {
    chatDb.messages.delete(id).catch(err => console.warn("[ChatDB] delete message failed:", err));
}

export function dbDeleteMessagesBySession(sessionId: string): void {
    chatDb.messages.where("sessionId").equals(sessionId).delete()
        .catch(err => console.warn("[ChatDB] delete session messages failed:", err));
}

export function dbDeleteMessagesByIds(ids: string[]): void {
    chatDb.messages.bulkDelete(ids).catch(err => console.warn("[ChatDB] bulkDelete messages failed:", err));
}

export function dbPutSession(session: ChatSession): void {
    chatDb.sessions.put(session).catch(err => console.warn("[ChatDB] put session failed:", err));
}

export function dbPutSessions(sessions: ChatSession[]): void {
  chatDb.sessions.bulkPut(sessions).catch(err => console.warn("[ChatDB] bulkPut sessions failed:", err));
  pushToSupabase(sessions); // 👈 新增这一行，让数据自动上传到云端
}

export function dbReplaceSessions(sessions: ChatSession[]): void {
  chatDb.transaction("rw", chatDb.sessions, async () => {
    await chatDb.sessions.clear();
    await chatDb.sessions.bulkPut(sessions);
  }).catch(err => console.warn("[ChatDB] replace sessions failed:", err));
  pushToSupabase(sessions); // 👈 新增这一行，让数据自动上传到云端
}

export function dbDeleteSession(id: string): void {
    chatDb.sessions.delete(id).catch(err => console.warn("[ChatDB] delete session failed:", err));
}

export function dbPutContacts(contacts: ChatContact[]): void {
    chatDb.contacts.bulkPut(contacts).catch(err => console.warn("[ChatDB] bulkPut contacts failed:", err));
}

export function dbClearContacts(): void {
    chatDb.contacts.clear().catch(err => console.warn("[ChatDB] clear contacts failed:", err));
}

export function dbReplaceContacts(contacts: ChatContact[]): void {
    chatDb.transaction("rw", chatDb.contacts, async () => {
        await chatDb.contacts.clear();
        await chatDb.contacts.bulkPut(contacts);
    }).catch(err => console.warn("[ChatDB] replaceContacts failed:", err));
}

// 在应用启动时调用，自动拉取云端数据
export async function initSync() {
  // 如果本次会话已经同步过了，就不要重复刷新了，避免死循环
  if (typeof window !== 'undefined' && sessionStorage.getItem('cloud_synced')) return;
  
  console.log('正在从云端同步数据...');
  const hasCloudData = await pullFromSupabase();
  
  if (hasCloudData) {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('cloud_synced', 'true');
      console.log('数据已同步，正在刷新页面...');
      window.location.reload(); 
    }
  }
}
