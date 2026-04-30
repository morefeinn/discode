import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AccountProvider, AccountState, DiscodeAccount } from './router.js';

export interface CredentialCandidate extends Partial<DiscodeAccount> {
    provider: AccountProvider;
    source: string;
}

export interface CredentialImportResult {
    imported: DiscodeAccount[];
    skipped: CredentialCandidate[];
}

const providerEnvKeys: Record<AccountProvider, string[]> = {
    codex: ['OPENAI_API_KEY'],
    opencode: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ZAI_API_KEY', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    zai: ['ZAI_API_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    groq: ['GROQ_API_KEY'],
    custom: []
};

export async function discoverCredentialCandidates(rootDir = process.cwd(), env: Record<string, string | undefined> = process.env): Promise<CredentialCandidate[]> {
    const candidates: CredentialCandidate[] = [];
    const mergedEnv = { ...readEnvFile(path.join(rootDir, '.env')), ...env };

    candidates.push(...discoverEnvKeys(mergedEnv));
    candidates.push(...await discoverCodexAuth());
    candidates.push(...await discoverOpenCodeAuth());

    return uniqueCandidates(candidates);
}

export async function importCredentialCandidates(accountsPath: string, candidates: CredentialCandidate[], activateFirst = true): Promise<CredentialImportResult> {
    const state = await readAccountState(accountsPath);
    const imported: DiscodeAccount[] = [];
    const skipped: CredentialCandidate[] = [];

    for (const candidate of candidates) {
        if (hasEquivalentAccount(state, candidate)) {
            skipped.push(candidate);
            continue;
        }
        const account = normalizeAccount(candidate, state.accounts.length + 1);

        account.id = uniqueAccountId(state, account.id);

        state.accounts.push(account);
        imported.push(account);
        if (activateFirst && !state.active_account_id) state.active_account_id = account.id;
    }

    if (imported.length > 0) {
        await mkdir(path.dirname(accountsPath), { recursive: true });
        await writeFile(accountsPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    }

    return { imported, skipped };
}

function discoverEnvKeys(env: Record<string, string | undefined>): CredentialCandidate[] {
    const candidates: CredentialCandidate[] = [];

    for (const provider of ['opencode', 'codex', 'anthropic', 'zai', 'qwen', 'groq'] as AccountProvider[]) {
        for (const key of providerEnvKeys[provider]) {
            const value = env[key]?.trim();

            if (!value) continue;
            candidates.push({
                provider,
                name: `${providerLabel(provider)} ${key}`,
                auth_mode: 'api_key',
                auth_data: {
                    api_key: value,
                    env_key: key
                },
                source: `.env/${key}`
            });
        }
    }

    return candidates;
}

async function discoverCodexAuth(): Promise<CredentialCandidate[]> {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const parsed = await readJson(authPath);
    const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : parsed;

    if (!tokens?.access_token || !tokens?.account_id) return [];

    return [{
        provider: 'codex',
        name: 'Codex session',
        auth_mode: 'session',
        auth_data: tokens,
        source: authPath
    }];
}

async function discoverOpenCodeAuth(): Promise<CredentialCandidate[]> {
    const paths = [
        path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
        path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
        path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'auth.json')
    ];
    const candidates: CredentialCandidate[] = [];

    for (const authPath of paths) {
        const parsed = await readJson(authPath);

        if (!parsed) continue;
        const credentials = flattenCredentialJson(parsed);

        if (credentials.length === 0) {
            candidates.push({
                provider: 'opencode',
                name: 'OpenCode local auth',
                auth_mode: 'wrapper',
                auth_data: { source_path: authPath },
                source: authPath
            });
            continue;
        }

        for (const credential of credentials) {
            const provider = providerFromId(credential.provider);
            const envKey = defaultEnvKey(provider);

            candidates.push({
                provider,
                name: `${providerLabel(provider)} from OpenCode`,
                auth_mode: 'api_key',
                auth_data: {
                    api_key: credential.key,
                    env_key: envKey,
                    source_provider: credential.provider,
                    source_path: authPath
                },
                source: authPath
            });
        }
    }

    return candidates;
}

function flattenCredentialJson(value: unknown, provider = ''): { provider: string; key: string }[] {
    if (!value || typeof value !== 'object') return [];
    const entries: { provider: string; key: string }[] = [];

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const nextProvider = provider && !isGenericProviderContainer(provider) ? provider : key;

        if (typeof child === 'string' && isSecretKeyName(key) && child.trim()) {
            entries.push({ provider: nextProvider, key: child.trim() });
        } else if (child && typeof child === 'object') {
            entries.push(...flattenCredentialJson(child, nextProvider));
        }
    }

    return entries;
}

function isSecretKeyName(value: string): boolean {
    return /api[_-]?key|token|secret/i.test(value);
}

function isGenericProviderContainer(value: string): boolean {
    return /^(auth|credential|credentials|provider|providers|tokens?)$/i.test(value);
}

async function readJson(filePath: string): Promise<any | null> {
    try {
        if (!existsSync(filePath)) return null;
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function readEnvFile(filePath: string): Record<string, string> {
    if (!existsSync(filePath)) return {};
    const values: Record<string, string> = {};

    try {
        for (const line of readFileSync(filePath, 'utf8').split('\n')) {
            const trimmed = line.trim();
            const index = trimmed.indexOf('=');

            if (!trimmed || trimmed.startsWith('#') || index < 0) continue;
            values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
        }
    } catch {}

    return values;
}

async function readAccountState(accountsPath: string): Promise<AccountState> {
    try {
        return normalizeState(JSON.parse(await readFile(accountsPath, 'utf8')) as AccountState);
    } catch {
        return { version: 1, accounts: [] };
    }
}

function normalizeState(state: AccountState): AccountState {
    return {
        version: state.version || 1,
        active_account_id: state.active_account_id,
        accounts: (state.accounts || []).map((account, index) => normalizeAccount(account, index + 1))
    };
}

function normalizeAccount(candidate: Partial<DiscodeAccount>, index: number): DiscodeAccount {
    const provider = providerFromId(candidate.provider);

    return {
        id: candidate.id || uniqueId(candidate.name || provider, index),
        name: candidate.name?.trim() || `${providerLabel(provider)} ${index}`,
        provider,
        email: candidate.email,
        plan_type: candidate.plan_type || candidate.auth_mode || 'api_key',
        auth_mode: candidate.auth_mode || 'api_key',
        auth_data: candidate.auth_data || {},
        env: candidate.env,
        command: candidate.command?.trim() || undefined,
        usage_command: candidate.usage_command?.trim() || undefined,
        model: candidate.model?.trim() || undefined,
        priority: Number.isFinite(candidate.priority) ? Number(candidate.priority) : index,
        last_used_at: candidate.last_used_at
    };
}

function hasEquivalentAccount(state: AccountState, candidate: CredentialCandidate): boolean {
    const candidateKey = credentialKey(candidate);

    return state.accounts.some(account => account.provider === candidate.provider && credentialKey(account) === candidateKey);
}

function credentialKey(account: Partial<DiscodeAccount>): string {
    const auth = account.auth_data || {};
    const key = stringValue(auth.api_key) || stringValue(auth.key) || stringValue(auth.token) || stringValue(auth.access_token);
    const accountId = stringValue(auth.account_id);

    return key || accountId || `${account.auth_mode || ''}:${stringValue(auth.source_path)}`;
}

function uniqueCandidates(candidates: CredentialCandidate[]): CredentialCandidate[] {
    const seen = new Set<string>();

    return candidates.filter(candidate => {
        const key = `${candidate.provider}:${credentialKey(candidate)}`;

        if (seen.has(key)) return false;
        seen.add(key);

        return true;
    });
}

function providerFromId(value: unknown): AccountProvider {
    const normalized = typeof value === 'string' ? value.toLowerCase() : '';

    if (normalized.includes('anthropic') || normalized.includes('claude')) return 'anthropic';
    if (normalized.includes('zai') || normalized.includes('z.ai') || normalized.includes('glm')) return 'zai';
    if (normalized.includes('qwen') || normalized.includes('dashscope') || normalized.includes('alibaba')) return 'qwen';
    if (normalized.includes('groq')) return 'groq';
    if (normalized.includes('opencode')) return 'opencode';
    if (normalized.includes('custom')) return 'custom';

    return 'codex';
}

function defaultEnvKey(provider: AccountProvider): string {
    if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
    if (provider === 'zai') return 'ZAI_API_KEY';
    if (provider === 'qwen') return 'QWEN_API_KEY';
    if (provider === 'groq') return 'GROQ_API_KEY';

    return 'OPENAI_API_KEY';
}

function providerLabel(provider: AccountProvider): string {
    if (provider === 'anthropic') return 'Anthropic';
    if (provider === 'zai') return 'Z.ai';
    if (provider === 'qwen') return 'Qwen';
    if (provider === 'groq') return 'Groq';
    if (provider === 'opencode') return 'OpenCode';
    if (provider === 'custom') return 'Custom';

    return 'Codex';
}

function uniqueId(value: string, index: number): string {
    const base = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || `account-${index}`;

    return `${base}-${index}`;
}

function uniqueAccountId(state: AccountState, value: string): string {
    const base = value || 'account';
    let id = base;
    let suffix = 2;

    while (state.accounts.some(account => account.id === id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
    }

    return id;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}
