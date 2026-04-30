import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type ProviderType = 'codex' | 'opencode' | 'anthropic' | 'zai' | 'qwen' | 'custom';
export type PermissionMode = 'full' | 'directory' | 'auto-review';
export type AgentNamingMode = 'greek' | 'custom';

export interface BridgeSettings {
    model?: string | null;
    reasoningEffort?: ReasoningEffort;
    provider?: ProviderType;
    providerPriority?: ProviderType[];
    permissionMode?: PermissionMode;
    allowedUserIds?: string[];
    primaryAllowedUserId?: string | null;
    reminderPings?: boolean;
    notifyPromptFinished?: boolean;
    notifyPermissionRequired?: boolean;
    notifyUsageLimit?: boolean;
    slashResponsesEphemeral?: boolean;
    finalResponsesAsImages?: boolean;
    autoSwitchOnLimit?: boolean;
    agentNamingMode?: AgentNamingMode;
    customAgentNames?: string[];
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
export const DEFAULT_PROVIDER_PRIORITY: ProviderType[] = ['codex', 'opencode', 'anthropic', 'zai', 'qwen', 'custom'];
export const DEFAULT_AGENT_NAMES = [
    'Apollo',
    'Athena',
    'Hermes',
    'Artemis',
    'Ares',
    'Hera',
    'Zeus',
    'Poseidon',
    'Demeter',
    'Hephaestus',
    'Dionysus',
    'Hestia',
    'Persephone',
    'Hades',
    'Nike',
    'Iris',
    'Helios',
    'Selene',
    'Eos',
    'Atlas',
    'Prometheus',
    'Themis',
    'Hypnos',
    'Nemesis',
    'Morpheus',
    'Janus',
    'Minerva',
    'Vesta',
    'Juno',
    'Vulcan',
    'Ceres',
    'Fortuna'
];

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

export function getEffectiveProviderPriority(settings: BridgeSettings, defaultPriority: ProviderType[] = DEFAULT_PROVIDER_PRIORITY): ProviderType[] {
    const values = [...(settings.providerPriority || []), ...defaultPriority, ...DEFAULT_PROVIDER_PRIORITY]
        .filter(isProviderType);
    const seen = new Set<ProviderType>();

    return values.filter(provider => {
        if (seen.has(provider)) return false;
        seen.add(provider);

        return true;
    });
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

export function getEffectiveNotifyPromptFinished(settings: BridgeSettings, defaultReminderPings: boolean): boolean {
    return settings.notifyPromptFinished ?? settings.reminderPings ?? defaultReminderPings;
}

export function getEffectiveNotifyPermissionRequired(settings: BridgeSettings): boolean {
    return settings.notifyPermissionRequired ?? true;
}

export function getEffectiveNotifyUsageLimit(settings: BridgeSettings): boolean {
    return settings.notifyUsageLimit ?? true;
}

export function getEffectiveSlashResponsesEphemeral(settings: BridgeSettings): boolean {
    return settings.slashResponsesEphemeral ?? true;
}

export function getEffectiveFinalResponsesAsImages(settings: BridgeSettings): boolean {
    return settings.finalResponsesAsImages ?? true;
}

export function getEffectiveAutoSwitchOnLimit(settings: BridgeSettings, defaultValue: boolean): boolean {
    return settings.autoSwitchOnLimit ?? defaultValue;
}

export function getEffectiveAgentNames(settings: BridgeSettings): string[] {
    const customNames = Array.isArray(settings.customAgentNames)
        ? settings.customAgentNames.map(value => value.trim()).filter(Boolean)
        : [];

    if (settings.agentNamingMode === 'custom' && customNames.length > 0) {
        return [...customNames, ...DEFAULT_AGENT_NAMES].slice(0, 32);
    }

    return DEFAULT_AGENT_NAMES;
}

export function isAgentNamingMode(value: unknown): value is AgentNamingMode {
    return value === 'greek' || value === 'custom';
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

export function isProviderType(value: unknown): value is ProviderType {
    return value === 'codex'
        || value === 'opencode'
        || value === 'anthropic'
        || value === 'zai'
        || value === 'qwen'
        || value === 'custom';
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
