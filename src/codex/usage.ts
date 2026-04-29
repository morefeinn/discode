import { DiscodeAccount } from '../accounts/router.js';

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

function normalizeWindow(value: any): UsageWindow | null {
    if (!value) return null;
    const resetAt = value.reset_at
        ? new Date(Number(value.reset_at) * 1000).toISOString()
        : null;

    return {
        usedPercent: value.used_percent ?? null,
        windowSeconds: value.limit_window_seconds ?? null,
        resetAt
    };
}
