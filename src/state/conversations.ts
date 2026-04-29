import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ConversationRecord {
    discordChannelId: string;
    discordGuildId?: string | null;
    discordThreadId?: string | null;
    latestMessageId?: string | null;
    codexThreadId: string;
    name: string;
    workspace: string;
    model?: string | null;
    updatedAt: string;
}

interface ConversationFile {
    conversations: Record<string, ConversationRecord>;
}

const dataPath = path.resolve('data', 'conversations.json');

async function readStore(): Promise<ConversationFile> {
    try {
        return JSON.parse(await readFile(dataPath, 'utf8')) as ConversationFile;
    } catch {
        return { conversations: {} };
    }
}

async function writeStore(store: ConversationFile): Promise<void> {
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(store, null, 2) + '\n');
}

export async function getConversation(discordChannelId: string): Promise<ConversationRecord | null> {
    const store = await readStore();

    return store.conversations[discordChannelId] || null;
}

export async function saveConversation(record: ConversationRecord): Promise<void> {
    const store = await readStore();
    store.conversations[record.discordChannelId] = record;
    await writeStore(store);
}

export async function clearConversation(discordChannelId: string): Promise<void> {
    const store = await readStore();
    delete store.conversations[discordChannelId];
    await writeStore(store);
}

export async function listConversations(): Promise<ConversationRecord[]> {
    const store = await readStore();

    return Object.values(store.conversations)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function findConversation(query: string): Promise<ConversationRecord | null> {
    const normalized = query.trim().toLowerCase();

    if (!normalized) return null;
    const conversations = await listConversations();
    const index = Number(normalized);

    if (Number.isInteger(index) && index >= 1 && index <= conversations.length) {
        return conversations[index - 1];
    }

    return conversations.find(conversation =>
        conversation.discordChannelId === query
        || conversation.discordThreadId === query
        || conversation.codexThreadId.startsWith(query)
        || conversation.name.toLowerCase() === normalized
        || conversation.name.toLowerCase().includes(normalized)
    ) || null;
}
