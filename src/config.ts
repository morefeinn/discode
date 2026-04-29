import path from 'node:path';
import os from 'node:os';

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
    defaultPermissionMode: string;
    defaultReminderPings: boolean;
    codexBin: string;
    opencodeBin: string;
    providerCommand: string | null;
    runTimeoutMs: number;
    autoSwitchOnLimit: boolean;
    accountsPath: string;
    legacySwitcherImportPath: string;
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

export function loadConfig(): BridgeConfig {
    const token = process.env.DISCORD_TOKEN?.trim() || '';
    const clientId = process.env.DISCORD_CLIENT_ID?.trim() || '';
    const allowedUserIds = readList('ALLOWED_USER_IDS', 'ALLOWED_USER_ID');
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
        defaultProvider: process.env.DISCODE_PROVIDER?.trim() || process.env.DEFAULT_PROVIDER?.trim() || 'codex',
        defaultPermissionMode: process.env.DISCODE_PERMISSION_MODE?.trim() || process.env.DEFAULT_PERMISSION_MODE?.trim() || 'full',
        defaultReminderPings: readBoolean('DISCODE_REMINDER_PINGS', true),
        codexBin: process.env.CODEX_BIN?.trim() || 'codex',
        opencodeBin: process.env.OPENCODE_BIN?.trim() || 'opencode',
        providerCommand: process.env.DISCODE_PROVIDER_COMMAND?.trim() || null,
        runTimeoutMs: readNumber('CODEX_TIMEOUT_MS', 30 * 60 * 1000),
        autoSwitchOnLimit: readBoolean('AUTO_SWITCH_ON_LIMIT', true),
        accountsPath: process.env.DISCODE_ACCOUNTS_PATH?.trim() || path.join(process.cwd(), 'data', 'accounts.json'),
        legacySwitcherImportPath: process.env.CODEX_SWITCHER_IMPORT_PATH?.trim()
            || process.env.CODEX_SWITCHER_PATH?.trim()
            || path.join(os.homedir(), '.codex-switcher', 'accounts.json'),
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
