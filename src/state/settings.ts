import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type ProviderType = 'codex' | 'opencode' | 'custom';
export type PermissionMode = 'full' | 'directory' | 'auto-review';

export interface BridgeSettings {
    model?: string | null;
    reasoningEffort?: ReasoningEffort;
    provider?: ProviderType;
    permissionMode?: PermissionMode;
    reminderPings?: boolean;
    slashResponsesEphemeral?: boolean;
}

export interface ModelChoice {
    name: string;
    value: string;
}

interface SettingsFile {
    settings: BridgeSettings;
}

const dataPath = path.resolve('data', 'settings.json');
export const DEFAULT_MODEL_CHOICE = '__default__';

async function readStore(): Promise<SettingsFile> {
    try {
        return JSON.parse(await readFile(dataPath, 'utf8')) as SettingsFile;
    } catch {
        return { settings: {} };
    }
}

async function writeStore(store: SettingsFile): Promise<void> {
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(store, null, 2) + '\n');
}

export async function getBridgeSettings(): Promise<BridgeSettings> {
    return (await readStore()).settings;
}

export async function updateBridgeSettings(next: Partial<BridgeSettings>): Promise<BridgeSettings> {
    const store = await readStore();
    store.settings = {
        ...store.settings,
        ...next
    };
    await writeStore(store);

    return store.settings;
}

export function getConfiguredModel(defaultModel: string | null): string {
    if (defaultModel) return defaultModel;

    try {
        const configPath = path.join(os.homedir(), '.codex', 'config.toml');
        const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
        const match = configText.match(/^\s*model\s*=\s*"([^"]+)"/m);

        if (match) return match[1];
    } catch {}

    return 'config default';
}

export function getConfiguredReasoning(): ReasoningEffort {
    try {
        const configPath = path.join(os.homedir(), '.codex', 'config.toml');
        const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
        const match = configText.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);

        if (isReasoningEffort(match?.[1])) return match[1];
    } catch {}

    return 'none';
}

export function getEffectiveModel(settings: BridgeSettings, defaultModel: string | null): string {
    return settings.model || getConfiguredModel(defaultModel);
}

export function getEffectiveReasoning(settings: BridgeSettings): ReasoningEffort {
    return settings.reasoningEffort || getConfiguredReasoning();
}

export function getEffectiveProvider(settings: BridgeSettings, defaultProvider: string): ProviderType {
    return isProviderType(settings.provider) ? settings.provider : isProviderType(defaultProvider) ? defaultProvider : 'codex';
}

export function getEffectivePermissionMode(settings: BridgeSettings, defaultPermissionMode: string): PermissionMode {
    return isPermissionMode(settings.permissionMode)
        ? settings.permissionMode
        : isPermissionMode(defaultPermissionMode)
            ? defaultPermissionMode
            : 'full';
}

export function getEffectiveReminderPings(settings: BridgeSettings, defaultReminderPings: boolean): boolean {
    return settings.reminderPings ?? defaultReminderPings;
}

export function getEffectiveSlashResponsesEphemeral(settings: BridgeSettings): boolean {
    return settings.slashResponsesEphemeral ?? true;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

export function isProviderType(value: unknown): value is ProviderType {
    return value === 'codex' || value === 'opencode' || value === 'custom';
}

export function isPermissionMode(value: unknown): value is PermissionMode {
    return value === 'full' || value === 'directory' || value === 'auto-review';
}

export function listModelChoices(): ModelChoice[] {
    const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
    const values = new Set<string>();
    const configured = (process.env.DISCODE_MODEL_CHOICES || '').split(',');

    for (const model of configured) {
        if (model.trim()) values.add(model.trim());
    }

    try {
        const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
        const models = Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];

        for (const model of models) {
            const id = model?.id || model?.model || model?.name;

            if (typeof id === 'string' && id.trim()) values.add(id.trim());
        }
    } catch {}

    return [
        { name: 'Config default', value: DEFAULT_MODEL_CHOICE },
        ...[...values].slice(0, 24).map(value => ({
            name: value,
            value
        }))
    ];
}
