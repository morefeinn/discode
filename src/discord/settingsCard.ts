import sharp from 'sharp';
import { BridgeConfig } from '../config.js';
import {
    BridgeSettings,
    getEffectiveModel,
    getEffectivePermissionMode,
    getEffectiveProvider,
    getEffectiveReasoning,
    getEffectiveReminderPings,
    getEffectiveSlashResponsesEphemeral
} from '../state/settings.js';

export type SettingsPage = 'runtime' | 'access' | 'notifications';

const WIDTH = 1100;
const HEIGHT = 620;

export async function renderSettingsCard(settings: BridgeSettings, config: BridgeConfig, page: SettingsPage): Promise<Buffer> {
    return sharp(Buffer.from(renderSvg(settings, config, page))).png().toBuffer();
}

function renderSvg(settings: BridgeSettings, config: BridgeConfig, page: SettingsPage): string {
    const provider = getEffectiveProvider(settings, config.defaultProvider);
    const model = getEffectiveModel(settings, config.defaultModel);
    const reasoning = getEffectiveReasoning(settings);
    const permissionMode = getEffectivePermissionMode(settings, config.defaultPermissionMode);
    const reminderPings = getEffectiveReminderPings(settings, config.defaultReminderPings);
    const slashResponsesEphemeral = getEffectiveSlashResponsesEphemeral(settings);
    const rows = page === 'runtime'
        ? [
            row('Provider', label(provider), 166),
            row('Model', model, 246),
            row('Reasoning', label(reasoning), 326),
            row('Wrapper', provider === 'custom' ? commandState(config.providerCommand) : provider === 'opencode' ? config.opencodeBin : config.codexBin, 406)
        ]
        : page === 'access'
            ? [
                row('Permission', permissionLabel(permissionMode), 166),
                row('Workspace', config.defaultWorkspace, 246),
                row('Sandbox', permissionMode === 'auto-review' ? 'Read only' : permissionMode === 'directory' ? 'Directory scoped' : 'Full access', 326),
                row('Roblox extension', config.extensionRobloxApiKey ? 'Configured' : 'Not configured', 406)
            ]
            : [
                row('Done ping', reminderPings ? 'On' : 'Off', 166),
                row('Slash responses', slashResponsesEphemeral ? 'Ephemeral' : 'Public', 246),
                row('Usage switching', config.autoSwitchOnLimit ? 'On' : 'Off', 326),
                row('Scope', 'Servers, DMs, and group chats', 406)
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

    return 'Notifications';
}

function pageDescription(page: SettingsPage): string {
    if (page === 'runtime') return 'Provider, model, reasoning, and wrapper.';
    if (page === 'access') return 'Access, sandbox, and publishing.';

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
