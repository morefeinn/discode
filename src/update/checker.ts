import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UPDATE_CHECK_TTL_MS = 10 * 60 * 1000;

export interface UpdateStatus {
    ok: boolean;
    current: string;
    latest: string;
    updateAvailable: boolean;
    updateCommand: string;
    error?: string;
}

interface NoticeState {
    cliLatest?: string;
    discordLatest?: string;
}

let cachedStatus: { checkedAt: number; rootDir: string; status: UpdateStatus } | null = null;

export async function checkForUpdate(rootDir: string, force = false): Promise<UpdateStatus> {
    const normalizedRoot = path.resolve(rootDir);

    if (!force && cachedStatus && cachedStatus.rootDir === normalizedRoot && Date.now() - cachedStatus.checkedAt < UPDATE_CHECK_TTL_MS) {
        return cachedStatus.status;
    }

    const status = await fetchUpdateStatus(normalizedRoot);
    cachedStatus = {
        checkedAt: Date.now(),
        rootDir: normalizedRoot,
        status
    };

    return status;
}

export function formatUpdateNotice(status: UpdateStatus): string {
    if (!status.updateAvailable) return '';

    return `Discode update available: ${status.current} -> ${status.latest}. Run \`${status.updateCommand}\`, then restart with \`discode restart\`.`;
}

export async function shouldNotifyUpdate(rootDir: string, scope: keyof NoticeState, latest: string): Promise<boolean> {
    const state = await readNoticeState(rootDir);

    return state[scope] !== latest;
}

export async function markUpdateNotified(rootDir: string, scope: keyof NoticeState, latest: string): Promise<void> {
    const state = await readNoticeState(rootDir);

    state[scope] = latest;
    await writeNoticeState(rootDir, state);
}

async function fetchUpdateStatus(rootDir: string): Promise<UpdateStatus> {
    const updateCommand = 'discode update';

    if (!existsSync(path.join(rootDir, '.git'))) {
        return {
            ok: false,
            current: 'unknown',
            latest: 'unknown',
            updateAvailable: false,
            updateCommand,
            error: 'Discode is not running from a git checkout.'
        };
    }

    try {
        await git(rootDir, ['fetch', '--quiet', 'origin', 'main']);
        const current = await git(rootDir, ['rev-parse', '--short', 'HEAD']);
        const latest = await git(rootDir, ['rev-parse', '--short', 'origin/main']);
        const behind = Number(await git(rootDir, ['rev-list', '--count', 'HEAD..origin/main']));

        return {
            ok: true,
            current,
            latest,
            updateAvailable: Number.isFinite(behind) && behind > 0,
            updateCommand
        };
    } catch (error: any) {
        return {
            ok: false,
            current: 'unknown',
            latest: 'unknown',
            updateAvailable: false,
            updateCommand,
            error: error?.message || String(error)
        };
    }
}

async function git(rootDir: string, args: string[]): Promise<string> {
    const result = await execFileAsync('git', args, {
        cwd: rootDir,
        timeout: 15_000,
        maxBuffer: 1024 * 1024
    });

    return result.stdout.trim();
}

async function readNoticeState(rootDir: string): Promise<NoticeState> {
    try {
        return JSON.parse(await readFile(noticePath(rootDir), 'utf8')) as NoticeState;
    } catch {
        return {};
    }
}

async function writeNoticeState(rootDir: string, state: NoticeState): Promise<void> {
    const filePath = noticePath(rootDir);

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function noticePath(rootDir: string): string {
    return path.join(rootDir, 'data', 'update-notices.json');
}
