import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AccountProvider = 'codex' | 'opencode' | 'custom';

export interface DiscodeAccount {
    id: string;
    name: string;
    provider?: AccountProvider;
    email?: string;
    plan_type?: string;
    subscription_expires_at?: string;
    auth_mode?: string;
    auth_data?: Record<string, unknown>;
    env?: Record<string, string>;
    command?: string;
    model?: string;
    last_used_at?: string;
}

export interface AccountState {
    version?: number;
    accounts: DiscodeAccount[];
    active_account_id?: string;
}

export interface AccountSummary {
    index: number;
    id: string;
    name: string;
    email: string;
    provider: AccountProvider;
    planType: string;
    subscriptionExpiresAt: string;
    lastUsedAt: string;
    active: boolean;
}

interface LegacySwitcherState {
    version?: number;
    accounts: DiscodeAccount[];
    active_account_id?: string;
}

export class AccountRouter {
    constructor(
        private readonly accountsPath: string,
        private readonly codexAuthPath: string,
        private readonly legacySwitcherPath: string
    ) {}

    async readState(): Promise<AccountState> {
        const nativeState = await this.readNativeState();

        if (nativeState) return nativeState;

        const importedState = await this.readLegacyState();

        if (importedState) {
            await this.writeState(importedState);
            return importedState;
        }

        return { version: 1, accounts: [] };
    }

    async listAccounts(): Promise<AccountSummary[]> {
        const state = await this.readState();

        return state.accounts.map((account, index) => ({
            index: index + 1,
            id: account.id,
            name: this.accountName(account, index),
            email: 'hidden',
            provider: this.normalizeProvider(account.provider),
            planType: account.plan_type || this.authMode(account) || 'unknown',
            subscriptionExpiresAt: account.subscription_expires_at || 'unknown',
            lastUsedAt: account.last_used_at || 'never',
            active: account.id === state.active_account_id
        }));
    }

    async getActiveAccount(): Promise<DiscodeAccount | null> {
        const state = await this.readState();

        return state.accounts.find(account => account.id === state.active_account_id) || state.accounts[0] || null;
    }

    async getActiveProvider(): Promise<AccountProvider | null> {
        const account = await this.getActiveAccount();

        return account ? this.normalizeProvider(account.provider) : null;
    }

    async getActiveCommand(): Promise<string | null> {
        const account = await this.getActiveAccount();

        return account?.command?.trim() || null;
    }

    async getActiveEnvironment(): Promise<Record<string, string>> {
        const account = await this.getActiveAccount();
        const env: Record<string, string> = {};

        if (!account) return env;

        for (const [key, value] of Object.entries(account.env || {})) {
            if (typeof value === 'string' && key.trim()) env[key] = value;
        }

        const authData = account.auth_data || {};
        const apiKey = this.stringValue(authData.api_key) || this.stringValue(authData.key) || this.stringValue(authData.token);
        const envKey = this.stringValue(authData.env_key);

        if (apiKey) env[envKey || 'OPENAI_API_KEY'] = apiKey;
        this.assignAuthEnv(env, 'OPENAI_BASE_URL', authData.base_url);
        this.assignAuthEnv(env, 'OPENAI_ORG_ID', authData.organization);
        this.assignAuthEnv(env, 'OPENAI_PROJECT_ID', authData.project);
        this.assignAuthEnv(env, 'ANTHROPIC_API_KEY', authData.anthropic_api_key);
        this.assignAuthEnv(env, 'GOOGLE_API_KEY', authData.google_api_key);

        env.DISCODE_ACTIVE_ACCOUNT = account.name || account.id;
        env.DISCODE_ACTIVE_PROVIDER = this.normalizeProvider(account.provider);

        return env;
    }

    async switchTo(query: string): Promise<DiscodeAccount> {
        const state = await this.readState();

        if (state.accounts.length === 0) {
            throw new Error('No Discode accounts were found.');
        }

        const account = query.trim().toLowerCase() === 'next'
            ? this.findNextAccount(state)
            : this.findAccount(state, query);

        if (!account) {
            throw new Error(`No account matched "${query}".`);
        }

        await this.activateAccount(state, account);

        return account;
    }

    async switchToNext(): Promise<DiscodeAccount | null> {
        const state = await this.readState();

        if (state.accounts.length === 0) return null;

        const account = this.findNextAccount(state);
        await this.activateAccount(state, account);

        return account;
    }

    private async readNativeState(): Promise<AccountState | null> {
        if (!existsSync(this.accountsPath)) return null;

        const state = JSON.parse(await readFile(this.accountsPath, 'utf8')) as AccountState;

        return this.normalizeState(state);
    }

    private async readLegacyState(): Promise<AccountState | null> {
        if (!existsSync(this.legacySwitcherPath)) return null;

        const legacy = JSON.parse(await readFile(this.legacySwitcherPath, 'utf8')) as LegacySwitcherState;

        return this.normalizeState({
            version: 1,
            active_account_id: legacy.active_account_id,
            accounts: (legacy.accounts || []).map((account, index) => ({
                id: account.id || `codex-${index + 1}`,
                name: this.accountName(account, index),
                provider: 'codex',
                email: account.email,
                plan_type: account.plan_type,
                subscription_expires_at: account.subscription_expires_at,
                auth_mode: account.auth_mode || String(account.auth_data?.type || 'session'),
                auth_data: account.auth_data,
                last_used_at: account.last_used_at
            }))
        });
    }

    private normalizeState(state: AccountState): AccountState {
        return {
            version: state.version || 1,
            active_account_id: state.active_account_id,
            accounts: (state.accounts || []).map((account, index) => ({
                ...account,
                id: account.id || `account-${index + 1}`,
                name: this.accountName(account, index),
                provider: this.normalizeProvider(account.provider)
            }))
        };
    }

    private async writeState(state: AccountState): Promise<void> {
        mkdirSync(path.dirname(this.accountsPath), { recursive: true });
        await writeFile(this.accountsPath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    }

    private findNextAccount(state: AccountState): DiscodeAccount {
        const activeIndex = state.accounts.findIndex(account => account.id === state.active_account_id);
        const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % state.accounts.length;

        return state.accounts[nextIndex];
    }

    private findAccount(state: AccountState, query: string): DiscodeAccount | null {
        const normalized = query.trim().toLowerCase();
        const index = Number(normalized);

        if (Number.isInteger(index) && index >= 1 && index <= state.accounts.length) {
            return state.accounts[index - 1];
        }

        return state.accounts.find(account =>
            account.id.toLowerCase().startsWith(normalized)
            || account.name.toLowerCase() === normalized
            || account.name.toLowerCase().includes(normalized)
            || account.email?.toLowerCase() === normalized
        ) || null;
    }

    private async activateAccount(state: AccountState, account: DiscodeAccount): Promise<void> {
        account.last_used_at = new Date().toISOString();
        state.active_account_id = account.id;
        await this.writeState(state);

        if (this.normalizeProvider(account.provider) !== 'codex') return;
        if (!this.hasCodexSession(account)) return;

        const tokens = { ...(account.auth_data || {}) };
        delete tokens.type;
        mkdirSync(path.dirname(this.codexAuthPath), { recursive: true });
        await writeFile(this.codexAuthPath, JSON.stringify({
            tokens,
            last_refresh: new Date().toISOString()
        }, null, 2) + '\n', { mode: 0o600 });
    }

    private normalizeProvider(provider: string | undefined): AccountProvider {
        if (provider === 'opencode' || provider === 'custom') return provider;

        return 'codex';
    }

    private authMode(account: DiscodeAccount): string {
        return account.auth_mode || String(account.auth_data?.type || '');
    }

    private hasCodexSession(account: DiscodeAccount): boolean {
        return Boolean(account.auth_data?.access_token && account.auth_data?.account_id);
    }

    private accountName(account: Partial<DiscodeAccount>, index: number): string {
        const name = account.name?.trim();

        if (!name || name.includes('@')) return `Account ${index + 1}`;

        return name;
    }

    private assignAuthEnv(env: Record<string, string>, key: string, value: unknown): void {
        const normalized = this.stringValue(value);

        if (normalized) env[key] = normalized;
    }

    private stringValue(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }
}
