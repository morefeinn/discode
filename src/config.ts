import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { DEFAULT_PROVIDER_PRIORITY, ProviderType, isProviderType } from './state/settings.js';

export interface BridgeConfig {
    token: string;
    clientId: string;
    allowedUserIds: string[];
    primaryAllowedUserId: string;
    commandName: string | null;
    defaultWorkspace: string;
    defaultSandbox: string;
    defaultModel: string | null;
    defaultProvider: string;
    defaultProviderPriority: ProviderType[];
    defaultPermissionMode: string;
    defaultReminderPings: boolean;
    codexBin: string;
    opencodeBin: string;
    anthropicBin: string;
    zaiBin: string;
    qwenBin: string;
    providerCommand: string | null;
    runTimeoutMs: number;
    autoSwitchOnLimit: boolean;
    accountsPath: string;
    codexAuthPath: string;
    extensionRobloxApiKey: string | null;
    extensionRobloxUniverseId: string | null;
    extensionRobloxPlaceId: string | null;
}

function readBoolean(name: string, defaultValue: boolean): boolean {
    const value = process.env[name];

    if (value === undefined) return defaultValue;

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function readNumber(name: string, defaultValue: number): number {
    const value = Number(process.env[name]);

    if (!Number.isFinite(value) || value <= 0) return defaultValue;

    return value;
}

function readList(...names: string[]): string[] {
    const values = names
        .flatMap(name => (process.env[name] || '').split(','))
        .map(value => value.trim())
        .filter(Boolean);

    return Array.from(new Set(values));
}

function readSettingsAllowedUsers(): string[] {
    try {
        const parsed = JSON.parse(readFileSync(path.resolve('data', 'settings.json'), 'utf8'));
        const values = Array.isArray(parsed?.settings?.allowedUserIds) ? parsed.settings.allowedUserIds : [];

        return values
            .map((value: unknown) => typeof value === 'string' ? value.trim() : '')
            .filter(Boolean);
    } catch {
        return [];
    }
}

function readProviderPriority(): ProviderType[] {
    const configured = readList('DISCODE_PROVIDER_PRIORITY', 'PROVIDER_PRIORITY')
        .map(value => value.toLowerCase())
        .filter(isProviderType);
    const values = configured.length > 0 ? configured : DEFAULT_PROVIDER_PRIORITY;
    const seen = new Set<ProviderType>();

    return values.filter(provider => {
        if (seen.has(provider)) return false;
        seen.add(provider);

        return true;
    });
}

export function loadConfig(): BridgeConfig {
    const token = process.env.DISCORD_TOKEN?.trim() || '';
    const clientId = process.env.DISCORD_CLIENT_ID?.trim() || '';
    const allowedUserIds = Array.from(new Set([...readList('ALLOWED_USER_IDS', 'ALLOWED_USER_ID'), ...readSettingsAllowedUsers()]));
    const primaryAllowedUserId = process.env.PRIMARY_ALLOWED_USER_ID?.trim() || allowedUserIds[0] || '';

    return {
        token,
        clientId,
        allowedUserIds,
        primaryAllowedUserId,
        commandName: process.env.DISCODE_COMMAND_NAME?.trim() || null,
        defaultWorkspace: process.env.DEFAULT_WORKSPACE?.trim() || process.cwd(),
        defaultSandbox: process.env.DEFAULT_SANDBOX?.trim() || 'workspace-write',
        defaultModel: process.env.DEFAULT_MODEL?.trim() || null,
        defaultProvider: process.env.DISCODE_PROVIDER?.trim() || process.env.DEFAULT_PROVIDER?.trim() || 'discode',
        defaultProviderPriority: readProviderPriority(),
        defaultPermissionMode: process.env.DISCODE_PERMISSION_MODE?.trim() || process.env.DEFAULT_PERMISSION_MODE?.trim() || 'full',
        defaultReminderPings: readBoolean('DISCODE_REMINDER_PINGS', true),
        codexBin: process.env.CODEX_BIN?.trim() || 'codex',
        opencodeBin: process.env.OPENCODE_BIN?.trim() || 'opencode',
        anthropicBin: process.env.ANTHROPIC_BIN?.trim() || process.env.CLAUDE_BIN?.trim() || 'claude',
        zaiBin: process.env.ZAI_BIN?.trim() || 'zai',
        qwenBin: process.env.QWEN_BIN?.trim() || 'qwen',
        providerCommand: process.env.DISCODE_PROVIDER_COMMAND?.trim() || null,
        runTimeoutMs: readNumber('CODEX_TIMEOUT_MS', 30 * 60 * 1000),
        autoSwitchOnLimit: readBoolean('AUTO_SWITCH_ON_LIMIT', true),
        accountsPath: process.env.DISCODE_ACCOUNTS_PATH?.trim() || path.join(process.cwd(), 'data', 'accounts.json'),
        codexAuthPath: process.env.CODEX_AUTH_PATH?.trim() || path.join(os.homedir(), '.codex', 'auth.json'),
        extensionRobloxApiKey: process.env.DISCODE_EXTENSION_ROBLOX_API_KEY?.trim()
            || process.env.ROBLOX_API_KEY?.trim()
            || process.env.ROBLOX_OPEN_CLOUD_API_KEY?.trim()
            || null,
        extensionRobloxUniverseId: process.env.DISCODE_EXTENSION_ROBLOX_UNIVERSE_ID?.trim()
            || process.env.ROBLOX_UNIVERSE_ID?.trim()
            || null,
        extensionRobloxPlaceId: process.env.DISCODE_EXTENSION_ROBLOX_PLACE_ID?.trim()
            || process.env.ROBLOX_PLACE_ID?.trim()
            || null
    };
}
