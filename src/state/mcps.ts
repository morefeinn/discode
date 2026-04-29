import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface McpServerRecord {
    name: string;
    command: string;
    args: string[];
}

const configPath = path.join(os.homedir(), '.codex', 'config.toml');

export async function listMcpServers(): Promise<McpServerRecord[]> {
    const text = await readConfig();
    const matches = [...text.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)(?=^\[|\s*$)/gm)];

    return matches.map(match => ({
        name: match[1],
        command: readTomlString(match[2], 'command') || '',
        args: readTomlArray(match[2], 'args')
    }));
}

export async function addMcpServer(name: string, command: string, argsText: string): Promise<McpServerRecord> {
    const normalized = normalizeName(name);
    const text = await readConfig();

    if (!normalized) throw new Error('MCP name must use letters, numbers, underscores, or dashes.');
    if (!command.trim()) throw new Error('MCP command is required.');
    if (new RegExp(`^\\[mcp_servers\\.${escapeRegExp(normalized)}\\]`, 'm').test(text)) {
        throw new Error(`MCP "${normalized}" already exists.`);
    }
    const args = parseArgs(argsText);
    const block = [
        '',
        `[mcp_servers.${normalized}]`,
        `command = ${tomlString(command.trim())}`,
        args.length > 0 ? `args = [${args.map(tomlString).join(', ')}]` : ''
    ].filter(Boolean).join('\n');

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${text.trimEnd()}\n${block}\n`);

    return { name: normalized, command: command.trim(), args };
}

async function readConfig(): Promise<string> {
    if (!existsSync(configPath)) return '';

    return readFile(configPath, 'utf8');
}

function normalizeName(value: string): string {
    return value
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
}

function readTomlString(block: string, key: string): string | null {
    const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*\"([^\"]*)\"`, 'm'));

    return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : null;
}

function readTomlArray(block: string, key: string): string[] {
    const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'));

    if (!match) return [];

    return [...match[1].matchAll(/"([^"]*)"/g)].map(item => item[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}

function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (const char of input.trim()) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) quote = null;
            else current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (current) args.push(current);

    return args;
}

function tomlString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
