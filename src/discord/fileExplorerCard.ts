import { renderSvgToPng } from './rendering.js';

export interface FileExplorerEntry {
    name: string;
    kind: 'dir' | 'file';
    size: string;
}

export interface FileExplorerCardData {
    title: string;
    workspace: string;
    entries: FileExplorerEntry[];
    generatedAt: string;
}

const WIDTH = 1100;
const HEIGHT = 720;

export async function renderFileExplorerCard(data: FileExplorerCardData): Promise<Buffer> {
    return renderSvgToPng(renderSvg(data));
}

function renderSvg(data: FileExplorerCardData): string {
    const rows = data.entries.slice(0, 12).map((entry, index) => row(entry, 178 + index * 42)).join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="718" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text(data.title || 'Directory', 70, 76, 40, 420, '#f7f7f8', 800),
        text(shortPath(data.workspace), 70, 118, 22, 840, '#8e8ea0', 540),
        '<line x1="70" y1="142" x2="1030" y2="142" stroke="#343541" stroke-width="2"/>',
        rows || text('No readable entries.', 70, 210, 24, 420, '#8e8ea0', 540),
        text(data.generatedAt, 1030, 662, 20, 360, '#8e8ea0', 500, 'end'),
        '</svg>'
    ].join('');
}

function row(entry: FileExplorerEntry, y: number): string {
    const color = entry.kind === 'dir' ? '#8b5cf6' : '#10a37f';

    return [
        `<circle cx="84" cy="${y - 7}" r="7" fill="${color}"/>`,
        text(entry.name, 108, y, 22, 680, '#f7f7f8', entry.kind === 'dir' ? 720 : 560),
        text(entry.kind === 'dir' ? 'Directory' : 'File', 820, y, 19, 120, '#8e8ea0', 540),
        text(entry.size, 1030, y, 19, 160, '#c5c5d2', 560, 'end'),
        `<line x1="70" y1="${y + 16}" x2="1030" y2="${y + 16}" stroke="#30313a" stroke-width="1"/>`
    ].join('');
}

function shortPath(value: string): string {
    return value.replace(/^\/Users\/apple\b/, '~');
}

function text(value: string, x: number, y: number, size: number, maxWidth: number, color: string, weight: number, anchor = 'start'): string {
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
