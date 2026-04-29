import { DiscodeAccount } from '../accounts/router.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface UsageWindow {
    usedPercent?: number | null;
    windowSeconds?: number | null;
    resetAt?: string | null;
}

export interface AccountUsage {
    ok: boolean;
    error?: string;
    planType?: string | null;
    primaryWindow?: UsageWindow | null;
    secondaryWindow?: UsageWindow | null;
    hasCredits?: boolean | null;
    unlimitedCredits?: boolean | null;
    creditsBalance?: string | null;
}

export async function fetchAccountUsage(account: DiscodeAccount): Promise<AccountUsage> {
    if (account.usage_command?.trim()) {
        return fetchCommandUsage(account);
    }

    const staticUsage = getStaticUsage(account);

    if (staticUsage) return staticUsage;

    if (account.provider && account.provider !== 'codex') {
        return {
            ok: false,
            error: `${providerLabel(account.provider)} usage requires usage_command or credits data on the account.`
        };
    }

    if (account.auth_mode === 'api_key' || (account.auth_data as any)?.type === 'api_key') {
        return {
            ok: false,
            error: 'API key accounts do not expose Codex usage windows.'
        };
    }

    const token = String((account.auth_data as any)?.access_token || '');
    const accountId = String((account.auth_data as any)?.account_id || '');

    if (!token || !accountId) {
        return {
            ok: false,
            error: 'Missing account token data for usage lookup.'
        };
    }

    try {
        const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers: {
                authorization: `Bearer ${token}`,
                'chatgpt-account-id': accountId,
                'user-agent': 'codex-cli/1.0.0'
            }
        });
        const text = await response.text();

        if (!response.ok) {
            return {
                ok: false,
                error: `Usage API returned ${response.status}: ${text.slice(0, 300)}`
            };
        }
        const payload = JSON.parse(text);

        return {
            ok: true,
            planType: payload.plan_type || account.plan_type || null,
            primaryWindow: normalizeWindow(payload.rate_limit?.primary_window),
            secondaryWindow: normalizeWindow(payload.rate_limit?.secondary_window),
            hasCredits: payload.credits?.has_credits ?? null,
            unlimitedCredits: payload.credits?.unlimited ?? null,
            creditsBalance: payload.credits?.balance ?? null
        };
    } catch (error: any) {
        return {
            ok: false,
            error: error?.message || String(error)
        };
    }
}

async function fetchCommandUsage(account: DiscodeAccount): Promise<AccountUsage> {
    try {
        const command = parseArgs(account.usage_command || '');

        if (command.length === 0) {
            return {
                ok: false,
                error: 'usage_command is empty.'
            };
        }
        const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
            env: {
                ...process.env,
                ...getAccountEnvironment(account),
                NO_COLOR: '1'
            },
            timeout: 20_000,
            maxBuffer: 1024 * 1024
        });
        const parsed = parseUsagePayload(stdout.trim());

        if (parsed) return parsed;

        return {
            ok: false,
            error: (stdout || stderr || 'Usage command returned no readable usage data.').slice(0, 300)
        };
    } catch (error: any) {
        return {
            ok: false,
            error: error?.message || String(error)
        };
    }
}

function parseUsagePayload(text: string): AccountUsage | null {
    try {
        const payload = JSON.parse(text);

        return {
            ok: payload.ok ?? true,
            error: payload.error,
            planType: payload.planType || payload.plan_type || null,
            primaryWindow: normalizeWindow(payload.primaryWindow || payload.primary_window || payload.rate_limit?.primary_window),
            secondaryWindow: normalizeWindow(payload.secondaryWindow || payload.secondary_window || payload.rate_limit?.secondary_window),
            hasCredits: payload.hasCredits ?? payload.has_credits ?? null,
            unlimitedCredits: payload.unlimitedCredits ?? payload.unlimited_credits ?? payload.credits?.unlimited ?? null,
            creditsBalance: payload.creditsBalance || payload.credits_balance || payload.credits?.balance || null
        };
    } catch {
        const remaining = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:remaining|left)/i)?.[1];
        const balance = text.match(/(?:credits?|balance)\D+([\w$., -]+)/i)?.[1]?.trim();

        if (!remaining && !balance) return null;

        return {
            ok: true,
            primaryWindow: remaining ? { usedPercent: 100 - Number(remaining), windowSeconds: null, resetAt: null } : null,
            creditsBalance: balance || null
        };
    }
}

function getStaticUsage(account: DiscodeAccount): AccountUsage | null {
    const authData = account.auth_data || {};
    const creditsBalance = stringValue((account as any).credits_balance)
        || stringValue((authData as any).credits_balance)
        || stringValue((authData as any).credits?.balance);
    const remainingPercent = numberValue((account as any).remaining_percent)
        ?? numberValue((authData as any).remaining_percent);

    if (!creditsBalance && remainingPercent === null) return null;

    return {
        ok: true,
        planType: account.plan_type || null,
        primaryWindow: remainingPercent === null ? null : {
            usedPercent: 100 - remainingPercent,
            windowSeconds: null,
            resetAt: null
        },
        creditsBalance: creditsBalance || null
    };
}

function getAccountEnvironment(account: DiscodeAccount): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(account.env || {})) {
        if (typeof value === 'string' && key.trim()) env[key] = value;
    }
    const authData = account.auth_data || {};
    const apiKey = stringValue((authData as any).api_key) || stringValue((authData as any).key) || stringValue((authData as any).token);
    const envKey = stringValue((authData as any).env_key);

    if (apiKey) env[envKey || defaultApiKeyName(account.provider)] = apiKey;

    return env;
}

function defaultApiKeyName(provider: string | undefined): string {
    if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
    if (provider === 'zai') return 'ZAI_API_KEY';
    if (provider === 'qwen') return 'QWEN_API_KEY';

    return 'OPENAI_API_KEY';
}

function providerLabel(provider: string): string {
    if (provider === 'zai') return 'Z.ai';
    if (provider === 'qwen') return 'Qwen';
    if (provider === 'anthropic') return 'Anthropic';

    return provider;
}

function normalizeWindow(value: any): UsageWindow | null {
    if (!value) return null;
    const rawReset = value.reset_at ?? value.resetAt;
    const resetAt = rawReset
        ? typeof rawReset === 'string' && Number.isNaN(Number(rawReset))
            ? rawReset
            : new Date(Number(rawReset) * (Number(rawReset) > 9999999999 ? 1 : 1000)).toISOString()
        : null;

    return {
        usedPercent: value.used_percent ?? value.usedPercent ?? null,
        windowSeconds: value.limit_window_seconds ?? value.windowSeconds ?? null,
        resetAt
    };
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | null {
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;

    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (const char of input) {
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
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
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
