import { renderSvgToPng } from './rendering.js';

export interface FileTransferCardData {
    title: string;
    status: string;
    detail: string;
    path: string;
    size?: string;
    tone?: 'working' | 'done' | 'warning' | 'error';
}

const WIDTH = 1100;
const HEIGHT = 420;

export async function renderFileTransferCard(data: FileTransferCardData): Promise<Buffer> {
    return renderSvgToPng(renderSvg(data));
}

function renderSvg(data: FileTransferCardData): string {
    const color = data.tone === 'done'
        ? '#10a37f'
        : data.tone === 'warning'
            ? '#f59e0b'
            : data.tone === 'error'
                ? '#ef4444'
                : '#8b5cf6';

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="418" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text(data.title, 70, 78, 40, 520, '#f7f7f8', 800),
        `<circle cx="86" cy="154" r="9" fill="${color}"/>`,
        text(data.status, 112, 162, 27, 760, '#f7f7f8', 720),
        text(data.detail, 70, 224, 22, 920, '#c5c5d2', 540),
        text(shortPath(data.path), 70, 278, 21, 820, '#8e8ea0', 520),
        data.size ? text(data.size, 1030, 278, 21, 220, '#c5c5d2', 600, 'end') : '',
        '<line x1="70" y1="326" x2="1030" y2="326" stroke="#343541" stroke-width="1"/>',
        text(new Date().toLocaleString(), 1030, 370, 20, 360, '#8e8ea0', 500, 'end'),
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
