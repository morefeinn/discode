import { renderSvgToPng } from './rendering.js';

export interface ChatCardItem {
    index: number;
    name: string;
    workspace: string;
    updatedAt: string;
}

const WIDTH = 1200;
const HEIGHT = 760;

export async function renderChatCard(chats: ChatCardItem[]): Promise<Buffer> {
    return renderSvgToPng(renderSvg(chats));
}

function renderSvg(chats: ChatCardItem[]): string {
    const rows = chats.length === 0
        ? [emptyRow()]
        : chats.slice(0, 9).map((chat, index) => row(chat, 130 + index * 66));

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1198" height="758" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('Chats', 88, 84, 42, 300, '#f7f7f8', 800),
        text(`${chats.length.toLocaleString('en-US')} saved`, 1112, 80, 22, 260, '#8e8ea0', 600, 'end'),
        '<line x1="88" y1="112" x2="1112" y2="112" stroke="#343541" stroke-width="2"/>',
        rows.join(''),
        text(new Date().toLocaleString(), 600, 704, 20, 360, '#8e8ea0', 500, 'middle'),
        '</svg>'
    ].join('');
}

function row(chat: ChatCardItem, y: number): string {
    return [
        text(String(chat.index), 88, y + 30, 22, 42, '#8e8ea0', 700),
        text(chat.name, 142, y + 24, 25, 700, '#f7f7f8', 720),
        text(chat.workspace, 142, y + 52, 19, 500, '#8e8ea0', 520),
        text(chat.updatedAt, 1112, y + 36, 20, 250, '#c5c5d2', 560, 'end'),
        '<line x1="88" y1="' + (y + 64) + '" x2="1112" y2="' + (y + 64) + '" stroke="#2f3038" stroke-width="1"/>'
    ].join('');
}

function emptyRow(): string {
    return text('No saved chats.', 88, 170, 28, 500, '#c5c5d2', 620);
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
