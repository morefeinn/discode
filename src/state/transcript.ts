import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface TranscriptMessage {
    role: 'user' | 'assistant';
    text: string;
}

export async function getTranscript(threadId: string, limit = 6): Promise<TranscriptMessage[]> {
    const filePath = await findSessionFile(path.join(os.homedir(), '.codex', 'sessions'), threadId);

    if (!filePath) return [];
    const lines = (await readFile(filePath, 'utf8')).split('\n');
    const messages: TranscriptMessage[] = [];

    for (const line of lines) {
        if (!line.trim()) continue;

        try {
            const event = JSON.parse(line) as {
                type?: string;
                payload?: {
                    type?: string;
                    role?: string;
                    content?: { type?: string; text?: string }[];
                };
            };

            if (event.type !== 'response_item' || event.payload?.type !== 'message') continue;
            if (event.payload.role !== 'user' && event.payload.role !== 'assistant') continue;
            const text = (event.payload.content || [])
                .filter(item => item.type === 'input_text' || item.type === 'output_text')
                .map(item => item.text || '')
                .join('\n')
                .trim();

            if (!text || text.length > 20000) continue;
            messages.push({
                role: event.payload.role,
                text
            });
        } catch {
        }
    }

    return messages.slice(-limit);
}

async function findSessionFile(directory: string, threadId: string): Promise<string | null> {
    let entries;

    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            const found = await findSessionFile(entryPath, threadId);

            if (found) return found;
        } else if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
            return entryPath;
        }
    }

    return null;
}
