import { McpServerRecord } from '../state/mcps.js';
import { renderSvgToPng } from './rendering.js';

const WIDTH = 1100;
const HEIGHT = 620;

export async function renderMcpCard(servers: McpServerRecord[]): Promise<Buffer> {
    return renderSvgToPng(renderSvg(servers));
}

function renderSvg(servers: McpServerRecord[]): string {
    const rows = servers.slice(0, 8).map((server, index) => row(server, 152 + index * 50)).join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="618" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('MCP Servers', 70, 82, 40, 360, '#f7f7f8', 800),
        text(`${servers.length.toLocaleString('en-US')} configured`, 1030, 82, 22, 260, '#8e8ea0', 600, 'end'),
        rows || text('No MCP servers configured.', 70, 170, 24, 480, '#8e8ea0', 560),
        '</svg>'
    ].join('');
}

function row(server: McpServerRecord, y: number): string {
    return [
        `<line x1="70" y1="${y - 34}" x2="1030" y2="${y - 34}" stroke="#30313a" stroke-width="1"/>`,
        text(server.name, 70, y, 23, 260, '#f7f7f8', 700),
        text([server.command, ...server.args].join(' '), 350, y, 21, 620, '#c5c5d2', 520)
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
