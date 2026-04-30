import { renderSvgToPng } from './rendering.js';

export interface TerminalCardData {
    workspace: string;
    branch: string;
    clean: boolean;
    generatedAt: string;
}

const WIDTH = 1100;
const HEIGHT = 520;

export async function renderTerminalCard(data: TerminalCardData): Promise<Buffer> {
    return renderSvgToPng(renderSvg(data));
}

function renderSvg(data: TerminalCardData): string {
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="518" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('Terminal', 70, 84, 42, 360, '#f7f7f8', 800),
        text(shortPath(data.workspace), 70, 146, 25, 900, '#c5c5d2', 560),
        '<rect x="70" y="206" width="960" height="92" rx="22" fill="#26272b" stroke="#343541" stroke-width="1"/>',
        text('Git', 100, 247, 21, 120, '#8e8ea0', 620),
        text(data.branch || 'unknown', 185, 247, 23, 400, '#f7f7f8', 700),
        text(data.clean ? 'Clean' : 'Changed', 100, 280, 20, 220, data.clean ? '#10a37f' : '#f7f7f8', 620),
        text(data.generatedAt, 1030, 466, 20, 360, '#8e8ea0', 500, 'end'),
        '</svg>'
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
