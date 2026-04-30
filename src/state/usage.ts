import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataFile } from './paths.js';

export interface UsageLimitRecord {
    accountId?: string | null;
    accountName?: string | null;
    message: string;
    resetAt?: string | null;
    seenAt: string;
}

interface UsageFile {
    limits: UsageLimitRecord[];
}

const dataPath = dataFile('usage.json');

async function readStore(): Promise<UsageFile> {
    try {
        return JSON.parse(await readFile(dataPath, 'utf8')) as UsageFile;
    } catch {
        return { limits: [] };
    }
}

async function writeStore(store: UsageFile): Promise<void> {
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(store, null, 2) + '\n');
}

export async function recordUsageLimit(record: Omit<UsageLimitRecord, 'seenAt'>): Promise<void> {
    const store = await readStore();
    const nextRecord = {
        ...record,
        seenAt: new Date().toISOString()
    };

    store.limits = [
        nextRecord,
        ...store.limits.filter(limit => limit.accountId !== record.accountId)
    ].slice(0, 50);
    await writeStore(store);
}

export async function listUsageLimits(): Promise<UsageLimitRecord[]> {
    const store = await readStore();

    return store.limits.sort((a, b) => b.seenAt.localeCompare(a.seenAt));
}
