import { renderSvgToPng } from './rendering.js';

export interface UsageCardWindow {
    label: string;
    percent: number | null;
    duration: string;
    reset: string;
}

export interface UsageCardData {
    title: string;
    accountName: string;
    accountIndex: number;
    accountCount: number;
    plan: string;
    provider: string;
    credential: string;
    active: boolean;
    credits: string | null;
    primary: UsageCardWindow;
    secondary: UsageCardWindow;
    generatedAt: string;
}

export interface UsageOverviewAccount {
    name: string;
    provider: string;
    remainingPercent: number | null;
    active: boolean;
}

export interface UsageOverviewProvider {
    name: string;
    accountCount: number;
    remainingPercent: number | null;
}

export interface UsageOverviewData {
    title: string;
    accounts: UsageOverviewAccount[];
    providers: UsageOverviewProvider[];
    generatedAt: string;
}

const WIDTH = 1200;
const HEIGHT = 760;
const OVERVIEW_HEIGHT = 980;

export async function renderUsageCard(data: UsageCardData): Promise<Buffer> {
    return renderSvgToPng(renderSvg(data));
}

export async function renderUsageOverviewCard(data: UsageOverviewData): Promise<Buffer> {
    return renderSvgToPng(renderOverviewSvg(data));
}

function renderSvg(data: UsageCardData): string {
    const pageLabel = data.accountCount === 0 ? 'No accounts' : `Account ${data.accountIndex} of ${data.accountCount}`;

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        `<rect x="1" y="1" width="${WIDTH - 2}" height="${HEIGHT - 2}" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>`,
        text(pageLabel, 1112, 74, 22, 240, '#8e8ea0', 600, 'end'),
        text(data.accountName, 88, 116, 42, 400, '#f7f7f8', 780),
        meta('Provider', providerLabel(data.provider), 88, 174, 180),
        meta('Plan', capitalize(data.plan), 300, 174, 180),
        meta('Credential', data.credential, 512, 174, 300),
        meta('Status', data.active ? 'Active' : 'Available', 844, 174, 180),
        data.credits ? text(`Credits: ${data.credits}`, 88, 238, 20, 480, '#8e8ea0', 560) : '',
        windowBlock(data.primary, 72, 284, 1056),
        windowBlock(data.secondary, 72, 500, 1056),
        text(data.generatedAt, 600, 704, 20, 360, '#8e8ea0', 500, 'middle'),
        '</svg>'
    ].join('');
}

function renderOverviewSvg(data: UsageOverviewData): string {
    const totalAccounts = data.accounts.length;
    const active = data.accounts.find(account => account.active);
    const accounts = data.accounts.slice(0, 8);
    const providers = data.providers.slice(0, 5);

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${OVERVIEW_HEIGHT}" viewBox="0 0 ${WIDTH} ${OVERVIEW_HEIGHT}">`,
        `<rect x="1" y="1" width="${WIDTH - 2}" height="${OVERVIEW_HEIGHT - 2}" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>`,
        text('Overview', 1112, 74, 22, 240, '#8e8ea0', 600, 'end'),
        text(data.title, 88, 112, 42, 440, '#f7f7f8', 780),
        text(`${totalAccounts} account${totalAccounts === 1 ? '' : 's'} · Active ${active?.name || 'none'}`, 88, 164, 22, 760, '#8e8ea0', 540),
        text('Provider usage limits', 88, 238, 28, 420, '#f7f7f8', 740),
        ...providers.map((provider, index) => overviewRow(provider.name, `${provider.accountCount} account${provider.accountCount === 1 ? '' : 's'}`, provider.remainingPercent, 88, 292 + index * 82, 456)),
        text('Account split', 664, 238, 28, 320, '#f7f7f8', 740),
        ...accounts.map((account, index) => overviewRow(account.name, providerLabel(account.provider), account.remainingPercent, 664, 292 + index * 76, 448, account.active)),
        text(data.generatedAt, 600, 924, 20, 360, '#8e8ea0', 500, 'middle'),
        '</svg>'
    ].join('');
}

function overviewRow(labelValue: string, detail: string, remainingPercent: number | null, x: number, y: number, width: number, active = false): string {
    const labelColor = active ? '#f7f7f8' : '#c5c5d2';
    const percentLabel = remainingPercent === null ? 'Unknown' : `${formatPercent(remainingPercent)} remaining`;

    return [
        text(labelValue, x, y, 22, width - 150, labelColor, active ? 760 : 620),
        text(percentLabel, x + width, y, 20, 140, '#f7f7f8', 640, 'end'),
        text(detail, x, y + 28, 17, width - 150, '#8e8ea0', 520),
        bar(remainingPercent === null ? null : 100 - remainingPercent, x, y + 42, width, 16)
    ].join('');
}

function windowBlock(window: UsageCardWindow, x: number, y: number, width: number): string {
    const percentLabel = window.percent === null ? 'Unknown' : `${formatPercent(100 - window.percent)} remaining`;
    const reset = `Resets ${window.reset}`;

    return [
        `<rect x="${x}" y="${y}" width="${width}" height="184" rx="24" fill="#26272b" stroke="#343541" stroke-width="2"/>`,
        text(window.label, x + 30, y + 54, 31, width - 60, '#f7f7f8', 760),
        text(percentLabel, x + width - 30, y + 54, 29, 210, '#f7f7f8', 760, 'end'),
        bar(window.percent, x + 30, y + 94, width - 60, 28),
        text(`${window.duration} · ${reset}`, x + 30, y + 158, 23, width - 60, '#8e8ea0', 520)
    ].join('');
}

function bar(percent: number | null, x: number, y: number, width: number, height: number): string {
    const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));
    const remaining = 100 - clamped;
    const fillWidth = Math.round((remaining / 100) * width);
    const color = remaining <= 25 ? '#d4a72c' : '#10a37f';
    const radius = height / 2;

    return [
        `<clipPath id="bar-${x}-${y}"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath>`,
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="#343541"/>`,
        percent === null || fillWidth <= 0 ? '' : `<rect x="${x}" y="${y}" width="${fillWidth}" height="${height}" fill="${color}" clip-path="url(#bar-${x}-${y})"/>`,
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="none" stroke="#42444d" stroke-width="1"/>`
    ].join('');
}

function meta(label: string, value: string, x: number, y: number, width: number): string {
    return [
        text(label, x, y, 18, width, '#8e8ea0', 600),
        text(value, x, y + 34, 22, width, '#f7f7f8', 620)
    ].join('');
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
    const rendered = truncate(value, maxChars);

    return `<text x="${x}" y="${y}" fill="${color}" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="${size}" font-weight="${weight}" letter-spacing="0" text-anchor="${anchor}">${escapeXml(rendered)}</text>`;
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;

    return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '...';
}

function capitalize(value: string): string {
    if (!value) return value;

    return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function providerLabel(value: string): string {
    if (value === 'zai') return 'Z.ai';
    if (value === 'qwen') return 'Qwen';
    if (value === 'anthropic') return 'Anthropic';

    return capitalize(value);
}

function formatPercent(percent: number): string {
    return `${Math.round(Math.max(0, Math.min(100, percent))).toLocaleString('en-US')}%`;
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
