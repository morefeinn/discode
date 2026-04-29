import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexUsage } from '../codex/runner.js';

export interface TokenStatsRecord extends CodexUsage {
    conversationKey: string;
    turns: number;
    updatedAt: string;
}

interface TokenStatsFile {
    conversations: Record<string, TokenStatsRecord>;
}

const dataPath = path.resolve('data', 'token-stats.json');

async function readStore(): Promise<TokenStatsFile> {
    try {
        return JSON.parse(await readFile(dataPath, 'utf8')) as TokenStatsFile;
    } catch {
        return { conversations: {} };
    }
}

async function writeStore(store: TokenStatsFile): Promise<void> {
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(store, null, 2) + '\n');
}

export async function recordTokenUsage(conversationKey: string, usage: CodexUsage): Promise<TokenStatsRecord> {
    const store = await readStore();
    const previous = store.conversations[conversationKey];
    const next: TokenStatsRecord = {
        conversationKey,
        inputTokens: (previous?.inputTokens || 0) + (usage.inputTokens || 0),
        cachedInputTokens: (previous?.cachedInputTokens || 0) + (usage.cachedInputTokens || 0),
        outputTokens: (previous?.outputTokens || 0) + (usage.outputTokens || 0),
        reasoningOutputTokens: (previous?.reasoningOutputTokens || 0) + (usage.reasoningOutputTokens || 0),
        totalTokens: (previous?.totalTokens || 0) + (usage.totalTokens || 0),
        turns: (previous?.turns || 0) + 1,
        updatedAt: new Date().toISOString()
    };

    store.conversations[conversationKey] = next;
    await writeStore(store);

    return next;
}

export async function getTokenStats(conversationKey: string): Promise<TokenStatsRecord | null> {
    return (await readStore()).conversations[conversationKey] || null;
}
