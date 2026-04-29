import sharp from 'sharp';
import { BridgeConfig } from '../config.js';
import {
    BridgeSettings,
    getEffectiveModel,
    getEffectiveNotifyPermissionRequired,
    getEffectiveNotifyPromptFinished,
    getEffectiveNotifyUsageLimit,
    getEffectiveFinalResponsesAsImages,
    getEffectivePermissionMode,
    getEffectiveProvider,
    getEffectiveProviderPriority,
    getEffectiveReasoning,
    getEffectiveSlashResponsesEphemeral
} from '../state/settings.js';

export type SettingsPage = 'runtime' | 'access' | 'notifications' | 'display';

const WIDTH = 1100;
const HEIGHT = 620;

export async function renderSettingsCard(settings: BridgeSettings, config: BridgeConfig, page: SettingsPage): Promise<Buffer> {
    return sharp(Buffer.from(renderSvg(settings, config, page))).png().toBuffer();
}

function renderSvg(settings: BridgeSettings, config: BridgeConfig, page: SettingsPage): string {
    const provider = getEffectiveProvider(settings, config.defaultProvider);
    const model = getEffectiveModel(settings, config.defaultModel);
    const reasoning = getEffectiveReasoning(settings);
    const providerPriority = getEffectiveProviderPriority(settings, config.defaultProviderPriority);
    const permissionMode = getEffectivePermissionMode(settings, config.defaultPermissionMode);
    const notifyPromptFinished = getEffectiveNotifyPromptFinished(settings, config.defaultReminderPings);
    const notifyPermissionRequired = getEffectiveNotifyPermissionRequired(settings);
    const notifyUsageLimit = getEffectiveNotifyUsageLimit(settings);
    const slashResponsesEphemeral = getEffectiveSlashResponsesEphemeral(settings);
    const finalResponsesAsImages = getEffectiveFinalResponsesAsImages(settings);
    const allowedUsers = mergeAllowedUsers(config.allowedUserIds, settings.allowedUserIds || []);
    const rows = page === 'runtime'
        ? [
            row('Provider', label(provider), 166),
            row('Model', model, 246),
            row('Reasoning', label(reasoning), 326),
            row('Priority', providerPriority.map(label).join(' > '), 406),
            row('Wrapper', wrapperLabel(provider, config), 486)
        ]
        : page === 'access'
            ? [
                row('Permission', permissionLabel(permissionMode), 166),
                row('Allowed users', `${allowedUsers.length} configured`, 246),
                row('Primary notify', settings.primaryAllowedUserId || config.primaryAllowedUserId || allowedUsers[0] || 'Not set', 326),
                row('Sandbox', permissionMode === 'auto-review' ? 'Read only' : permissionMode === 'directory' ? 'Directory scoped' : 'Full access', 406),
                row('Workspace', config.defaultWorkspace, 486)
            ]
            : page === 'notifications'
                ? [
                row('Prompt finished', notifyPromptFinished ? 'Notify prompter' : 'Off', 166),
                row('Permission needed', notifyPermissionRequired ? 'Notify prompter' : 'Off', 246),
                row('Usage limits', notifyUsageLimit ? 'Notify prompter' : 'Off', 326),
                row('Slash responses', slashResponsesEphemeral ? 'Ephemeral' : 'Public', 406),
                row('Usage switching', config.autoSwitchOnLimit ? 'On' : 'Off', 486)
                ]
                : [
                    row('Final responses', finalResponsesAsImages ? 'Images' : 'Text', 166),
                    row('Token stats', 'Available from response controls', 246),
                    row('Terminal output', 'ANSI colors enabled', 326),
                    row('Button expiry', 'Disabled after 60 seconds', 406),
                    row('Slash responses', slashResponsesEphemeral ? 'Ephemeral' : 'Public', 486)
                ];

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="618" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('Discode', 70, 78, 42, 280, '#f7f7f8', 800),
        text(pageTitle(page), 1030, 78, 24, 360, '#8e8ea0', 600, 'end'),
        ...rows,
        text(pageDescription(page), 70, 546, 21, 560, '#8e8ea0', 520),
        text(new Date().toLocaleString(), 1030, 546, 20, 360, '#8e8ea0', 500, 'end'),
        '</svg>'
    ].join('');
}

function row(labelValue: string, value: string, y: number): string {
    return [
        `<line x1="70" y1="${y - 48}" x2="1030" y2="${y - 48}" stroke="#343541" stroke-width="1"/>`,
        text(labelValue, 70, y, 22, 260, '#8e8ea0', 620),
        text(value, 320, y, 26, 680, '#f7f7f8', 680)
    ].join('');
}

function pageTitle(page: SettingsPage): string {
    if (page === 'runtime') return 'Runtime';
    if (page === 'access') return 'Access';
    if (page === 'display') return 'Display';

    return 'Notifications';
}

function pageDescription(page: SettingsPage): string {
    if (page === 'runtime') return 'Provider, model, reasoning, and wrapper.';
    if (page === 'access') return 'Access, sandbox, and publishing.';
    if (page === 'display') return 'Cards, response format, and interactive controls.';

    return 'Privacy, pings, failover, and Discord scope.';
}

function permissionLabel(value: string): string {
    if (value === 'directory') return 'Directory only';
    if (value === 'auto-review') return 'Auto-review';

    return 'Full access';
}

function commandState(value: string | null): string {
    return value ? value : 'Set DISCODE_PROVIDER_COMMAND';
}

function wrapperLabel(provider: string, config: BridgeConfig): string {
    if (provider === 'custom') return commandState(config.providerCommand);
    if (provider === 'opencode') return config.opencodeBin;
    if (provider === 'anthropic') return config.anthropicBin;
    if (provider === 'zai') return config.zaiBin;
    if (provider === 'qwen') return config.qwenBin;

    return config.codexBin;
}

function mergeAllowedUsers(envUsers: string[], settingsUsers: string[]): string[] {
    return Array.from(new Set([...envUsers, ...settingsUsers].map(value => value.trim()).filter(Boolean)));
}

function label(value: string): string {
    if (value === 'xhigh') return 'XHigh';

    return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function text(
    value: string,
    x: number,
    y: number,
    size: number,
    maxWidth: number,
    color: string,
    weight: number,
    anchor = 'start'
): string {
    const maxChars = Math.max(4, Math.floor(maxWidth / (size * 0.56)));

    return `<text x="${x}" y="${y}" fill="${color}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="0" text-anchor="${anchor}">${escapeXml(truncate(value, maxChars))}</text>`;
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;

    return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '...';
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
