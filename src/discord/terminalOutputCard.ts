import sharp from 'sharp';

export interface TerminalOutputCardData {
    command: string;
    workspace: string;
    output: string;
    status: string;
    finished: boolean;
}

const WIDTH = 1100;
const HEIGHT = 760;
const MAX_LINES = 22;
const MAX_COLUMNS = 78;

export async function renderTerminalOutputCard(data: TerminalOutputCardData): Promise<Buffer> {
    return sharp(Buffer.from(renderSvg(data))).png().toBuffer();
}

function renderSvg(data: TerminalOutputCardData): string {
    const lines = compactLines(data.output || 'Starting...');
    const renderedLines = lines.map((line, index) => terminalText(line, 82, 220 + index * 22)).join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<defs><clipPath id="terminal-output-clip"><rect x="82" y="202" width="924" height="484" rx="10"/></clipPath></defs>',
        '<rect x="1" y="1" width="1098" height="758" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('Terminal', 70, 78, 40, 320, '#f7f7f8', 800),
        text(data.finished ? 'Done' : 'Running', 1030, 78, 22, 220, data.finished ? '#10a37f' : '#c5c5d2', 660, 'end'),
        text(shortPath(data.workspace), 70, 126, 21, 620, '#8e8ea0', 520),
        text(data.command, 70, 164, 22, 900, '#f7f7f8', 620),
        '<rect x="70" y="188" width="960" height="520" rx="18" fill="#17181d" stroke="#343541" stroke-width="1"/>',
        `<g clip-path="url(#terminal-output-clip)">${renderedLines}</g>`,
        text(data.status, 70, 736, 20, 760, '#8e8ea0', 500),
        '</svg>'
    ].join('');
}

function compactLines(output: string): string[] {
    const normalized = normalizeTerminalText(output
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ''));
    const lines = collapseProgressLines(normalized
        .split('\n')
        .map(line => line.replace(/[^\S\r\n]+$/g, ''))
        .filter(line => line.trim().length > 0)
    ).map(line => line.length > MAX_COLUMNS ? `${line.slice(0, MAX_COLUMNS - 1)}…` : line);

    return lines.slice(-MAX_LINES);
}

function normalizeTerminalText(output: string): string {
    const lines: string[] = [];
    let current = '';

    for (const char of output) {
        if (char === '\r') {
            current = '';
        } else if (char === '\n') {
            lines.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    if (current.length > 0) lines.push(current);

    return lines.join('\n');
}

function collapseProgressLines(lines: string[]): string[] {
    const collapsed: string[] = [];
    const progressPattern = /^\[[^\]]{4,}\]\s+\d+(?:\.\d+)?%/;

    for (const line of lines) {
        const isProgress = progressPattern.test(line.trim());
        const previous = collapsed.at(-1) || '';

        if (isProgress && progressPattern.test(previous.trim())) {
            collapsed[collapsed.length - 1] = line;
        } else {
            collapsed.push(line);
        }
    }

    return collapsed;
}

function shortPath(value: string): string {
    return value.replace(/^\/Users\/apple\b/, '~');
}

function terminalText(value: string, x: number, y: number): string {
    return `<text x="${x}" y="${y}" fill="#e8e8ef" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="18" font-weight="500" letter-spacing="0">${escapeXml(value)}</text>`;
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
