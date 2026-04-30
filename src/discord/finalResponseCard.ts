import { renderSvgToPng } from './rendering.js';

const WIDTH = 1100;
const HEIGHT = 860;
const MAX_LINES = 28;
const MAX_COLUMNS = 82;

export async function renderFinalResponseCards(value: string, title = 'Discode'): Promise<Buffer[]> {
    const lines = wrapResponse(cleanResponse(value));
    const pages = chunk(lines.length > 0 ? lines : ['Completed with no final message.'], MAX_LINES);

    return Promise.all(pages.map((page, index) => renderSvgToPng(renderSvg(page, title, pages.length, index + 1))));
}

function renderSvg(lines: string[], title: string, pageCount: number, page: number): string {
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="858" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text(title, 70, 78, 40, 380, '#f7f7f8', 800),
        text(pageCount > 1 ? `Response ${page}/${pageCount}` : 'Response', 1030, 78, 22, 260, '#8e8ea0', 600, 'end'),
        '<line x1="70" y1="112" x2="1030" y2="112" stroke="#343541" stroke-width="1"/>',
        ...lines.map((line, index) => bodyText(line, 70, 154 + index * 24)),
        '</svg>'
    ].join('');
}

function wrapResponse(value: string): string[] {
    const lines: string[] = [];

    for (const rawLine of value.split('\n')) {
        const line = rawLine.replace(/\t/g, '    ').trimEnd();

        if (!line.trim()) {
            lines.push('');
            continue;
        }
        if (line.length <= MAX_COLUMNS) {
            lines.push(line);
            continue;
        }

        let remaining = line;

        while (remaining.length > MAX_COLUMNS) {
            const breakAt = findBreak(remaining, MAX_COLUMNS);

            lines.push(remaining.slice(0, breakAt).trimEnd());
            remaining = remaining.slice(breakAt).trimStart();
        }
        if (remaining) lines.push(remaining);
    }

    return lines;
}

function findBreak(value: string, limit: number): number {
    const slice = value.slice(0, limit + 1);
    const space = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('/'), slice.lastIndexOf('-'));

    return space > limit * 0.55 ? space + 1 : limit;
}

function chunk<T>(values: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }

    return chunks;
}

function cleanResponse(value: string): string {
    return value
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .trim();
}

function bodyText(value: string, x: number, y: number): string {
    return `<text x="${x}" y="${y}" fill="#e8e8ef" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="21" font-weight="520" letter-spacing="0">${escapeXml(value || ' ')}</text>`;
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
