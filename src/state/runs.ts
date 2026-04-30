import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataFile } from './paths.js';

export interface RunRecord {
    id: string;
    type: 'prompt' | 'review';
    status: 'running' | 'completed' | 'failed';
    targetType: 'message' | 'interaction';
    channelId: string;
    messageId?: string | null;
    interactionToken?: string | null;
    applicationId?: string | null;
    conversationKey: string;
    prompt?: string;
    workspace?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    dangerous?: boolean;
    provider?: string | null;
    permissionMode?: string | null;
    fresh?: boolean;
    codexThreadId?: string | null;
    chatName?: string;
    discordThreadId?: string | null;
    imagePaths?: string[];
    createdAt: string;
    updatedAt: string;
}

interface RunFile {
    runs: Record<string, RunRecord>;
}

const dataPath = dataFile('runs.json');

async function readStore(): Promise<RunFile> {
    try {
        return JSON.parse(await readFile(dataPath, 'utf8')) as RunFile;
    } catch {
        return { runs: {} };
    }
}

async function writeStore(store: RunFile): Promise<void> {
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(store, null, 2) + '\n');
}

export async function saveRun(record: RunRecord): Promise<void> {
    const store = await readStore();
    store.runs[record.id] = {
        ...record,
        updatedAt: new Date().toISOString()
    };
    await writeStore(store);
}

export async function updateRun(id: string, updates: Partial<RunRecord>): Promise<void> {
    const store = await readStore();
    const current = store.runs[id];

    if (!current) return;
    store.runs[id] = {
        ...current,
        ...updates,
        updatedAt: new Date().toISOString()
    };
    await writeStore(store);
}

export async function listRunningRuns(): Promise<RunRecord[]> {
    const store = await readStore();

    return Object.values(store.runs)
        .filter(run => run.status === 'running')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
