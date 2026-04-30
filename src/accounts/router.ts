import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AccountProvider = 'codex' | 'opencode' | 'anthropic' | 'zai' | 'qwen' | 'custom';

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
    usage_command?: string;
    model?: string;
    priority?: number;
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
    credentialLabel: string;
    subscriptionExpiresAt: string;
    lastUsedAt: string;
    active: boolean;
}

export class AccountRouter {
    constructor(
        private readonly accountsPath: string,
        private readonly codexAuthPath: string
    ) {}

    async readState(): Promise<AccountState> {
        const nativeState = await this.readNativeState();

        if (nativeState) return nativeState;

        return { version: 1, accounts: [] };
    }

    async listAccounts(): Promise<AccountSummary[]> {
        const state = await this.readState();

        return this.getOrderedAccounts(state).map(({ account, originalIndex }, index) => ({
            index: index + 1,
            id: account.id,
            name: this.accountName(account, originalIndex),
            email: this.maskEmail(account.email),
            provider: this.normalizeProvider(account.provider),
            planType: account.plan_type || this.authMode(account) || 'unknown',
            credentialLabel: this.credentialLabel(account),
            subscriptionExpiresAt: account.subscription_expires_at || 'unknown',
            lastUsedAt: account.last_used_at || 'never',
            active: account.id === state.active_account_id
        }));
    }

    async getActiveAccount(provider?: AccountProvider | null): Promise<DiscodeAccount | null> {
        const state = await this.readState();
        const accounts = this.getOrderedAccounts(state).map(item => item.account);

        if (provider) {
            const active = accounts.find(account => account.id === state.active_account_id && this.normalizeProvider(account.provider) === provider);

            return active || accounts.find(account => this.normalizeProvider(account.provider) === provider) || null;
        }

        return accounts.find(account => account.id === state.active_account_id) || accounts[0] || null;
    }

    async getActiveProvider(): Promise<AccountProvider | null> {
        const account = await this.getActiveAccount();

        return account ? this.normalizeProvider(account.provider) : null;
    }

    async getActiveCommand(provider?: AccountProvider | null): Promise<string | null> {
        const account = await this.getActiveAccount(provider);

        return account?.command?.trim() || null;
    }

    async getActiveEnvironment(provider?: AccountProvider | null): Promise<Record<string, string>> {
        const account = await this.getActiveAccount(provider);
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

    async switchToNext(provider?: AccountProvider | null): Promise<DiscodeAccount | null> {
        const state = await this.readState();

        if (state.accounts.length === 0) return null;

        const account = this.findNextAccount(state, provider);

        if (!account) return null;
        await this.activateAccount(state, account);

        return account;
    }

    async addAccount(input: Partial<DiscodeAccount>, activate = false): Promise<DiscodeAccount> {
        const state = await this.readState();
        const provider = this.normalizeProvider(input.provider);
        const account: DiscodeAccount = {
            id: this.uniqueAccountId(state, input.id || input.name || provider),
            name: input.name?.trim() || `${this.providerLabel(provider)} ${state.accounts.length + 1}`,
            provider,
            email: input.email?.trim() || undefined,
            plan_type: input.plan_type?.trim() || input.auth_mode || 'api_key',
            auth_mode: input.auth_mode || 'api_key',
            auth_data: input.auth_data || {},
            env: input.env,
            command: input.command?.trim() || undefined,
            usage_command: input.usage_command?.trim() || undefined,
            model: input.model?.trim() || undefined,
            priority: Number.isFinite(input.priority) ? Number(input.priority) : state.accounts.length + 1,
            last_used_at: activate || state.accounts.length === 0 ? new Date().toISOString() : undefined
        };

        state.accounts.push(account);
        if (activate || !state.active_account_id) state.active_account_id = account.id;
        await this.writeState(state);

        if (state.active_account_id === account.id) {
            await this.activateAccount(state, account);
        }

        return account;
    }

    private async readNativeState(): Promise<AccountState | null> {
        if (!existsSync(this.accountsPath)) return null;

        const state = JSON.parse(await readFile(this.accountsPath, 'utf8')) as AccountState;

        return this.normalizeState(state);
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

    private findNextAccount(state: AccountState, provider?: AccountProvider | null): DiscodeAccount | null {
        const accounts = this.getOrderedAccounts(state)
            .map(item => item.account)
            .filter(account => !provider || this.normalizeProvider(account.provider) === provider);

        if (accounts.length === 0) return null;
        const activeIndex = accounts.findIndex(account => account.id === state.active_account_id);
        const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % accounts.length;

        return accounts[nextIndex];
    }

    private findAccount(state: AccountState, query: string): DiscodeAccount | null {
        const normalized = query.trim().toLowerCase();
        const index = Number(normalized);
        const accounts = this.getOrderedAccounts(state).map(item => item.account);

        if (Number.isInteger(index) && index >= 1 && index <= accounts.length) {
            return accounts[index - 1];
        }

        return accounts.find(account =>
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
        if (provider === 'opencode'
            || provider === 'anthropic'
            || provider === 'zai'
            || provider === 'qwen'
            || provider === 'custom') {
            return provider;
        }

        return 'codex';
    }

    private getOrderedAccounts(state: AccountState): { account: DiscodeAccount; originalIndex: number }[] {
        return state.accounts
            .map((account, originalIndex) => ({ account, originalIndex }))
            .sort((left, right) => {
                const leftPriority = Number.isFinite(left.account.priority) ? Number(left.account.priority) : left.originalIndex + 1000;
                const rightPriority = Number.isFinite(right.account.priority) ? Number(right.account.priority) : right.originalIndex + 1000;

                return leftPriority - rightPriority || left.originalIndex - right.originalIndex;
            });
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

    private credentialLabel(account: DiscodeAccount): string {
        const provider = this.normalizeProvider(account.provider);
        const authMode = this.authMode(account);
        const authData = account.auth_data || {};
        const envKey = this.stringValue(authData.env_key);
        const apiKey = this.stringValue(authData.api_key) || this.stringValue(authData.key) || this.stringValue(authData.token);

        if (apiKey) return `${envKey || this.defaultApiKeyName(provider)} ${this.maskSecret(apiKey)}`;
        if (account.email) return this.maskEmail(account.email);
        if (authMode) return authMode;

        return provider;
    }

    private defaultApiKeyName(provider: AccountProvider): string {
        if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
        if (provider === 'zai') return 'ZAI_API_KEY';
        if (provider === 'qwen') return 'QWEN_API_KEY';

        return 'OPENAI_API_KEY';
    }

    private uniqueAccountId(state: AccountState, value: string): string {
        const base = value
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'account';
        let id = base;
        let suffix = 2;

        while (state.accounts.some(account => account.id === id)) {
            id = `${base}-${suffix}`;
            suffix += 1;
        }

        return id;
    }

    private providerLabel(provider: AccountProvider): string {
        if (provider === 'anthropic') return 'Anthropic';
        if (provider === 'zai') return 'Z.ai';
        if (provider === 'qwen') return 'Qwen';
        if (provider === 'opencode') return 'OpenCode';

        return 'Codex';
    }

    private maskEmail(value: string | undefined): string {
        if (!value) return 'hidden';
        const [name, domain] = value.split('@');

        if (!name || !domain) return 'hidden';

        return `${name.slice(0, 2)}***@${domain}`;
    }

    private maskSecret(value: string): string {
        if (value.length <= 8) return 'configured';

        return `...${value.slice(-4)}`;
    }

    private assignAuthEnv(env: Record<string, string>, key: string, value: unknown): void {
        const normalized = this.stringValue(value);

        if (normalized) env[key] = normalized;
    }

    private stringValue(value: unknown): string {
        return typeof value === 'string' ? value.trim() : '';
    }
}
