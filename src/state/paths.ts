import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const migrated = new Set<string>();

export function appDataDir(): string {
    const xdgDataHome = process.env.XDG_DATA_HOME?.trim();

    return process.env.DISCODE_DATA_DIR?.trim()
        || (xdgDataHome ? path.join(xdgDataHome, 'discode') : '')
        || path.join(os.homedir(), '.discode');
}

export function dataFile(name: string): string {
    const target = path.join(appDataDir(), name);

    migrateLegacyFile(name, target);

    return target;
}

export function workspaceRoot(): string {
    return process.env.DISCODE_WORKSPACES_DIR?.trim()
        || path.join(appDataDir(), 'workspaces');
}

export function defaultWorkspacePath(name = 'default'): string {
    return path.join(workspaceRoot(), slugName(name));
}

export function slugName(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'default';
}

function migrateLegacyFile(name: string, target: string): void {
    if (migrated.has(name) || existsSync(target)) return;
    migrated.add(name);
    const legacy = path.resolve(process.cwd(), 'data', name);

    if (!existsSync(legacy)) return;
    try {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(legacy, target);
    } catch {
    }
}
