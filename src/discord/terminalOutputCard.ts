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
        .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ''));
    const lines = collapseProgressLines(normalized
        .split('\n')
        .map(line => line.replace(/[^\S\r\n]+$/g, ''))
        .filter(line => stripAnsi(line).trim().length > 0)
    ).map(line => truncateAnsiLine(line, MAX_COLUMNS));

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
    const segments = parseAnsiSegments(value);

    return [
        `<text x="${x}" y="${y}" font-family="SFMono-Regular, Menlo, Consolas, monospace" font-size="18" font-weight="500" letter-spacing="0">`,
        ...segments.map(segment => `<tspan fill="${segment.color}">${escapeXml(segment.text)}</tspan>`),
        '</text>'
    ].join('');
}

function parseAnsiSegments(value: string): { text: string; color: string }[] {
    const segments: { text: string; color: string }[] = [];
    const pattern = /\u001b\[([0-9;]*)m/g;
    let index = 0;
    let color = '#e8e8ef';
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(value))) {
        if (match.index > index) {
            segments.push({ text: value.slice(index, match.index), color });
        }
        color = applyAnsiColor(color, match[1]);
        index = pattern.lastIndex;
    }
    if (index < value.length) {
        segments.push({ text: value.slice(index), color });
    }

    return segments.length > 0 ? segments : [{ text: value, color }];
}

function applyAnsiColor(current: string, codesText: string): string {
    const codes = codesText.split(';').filter(Boolean).map(code => Number(code));

    if (codes.length === 0) return '#e8e8ef';
    for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index];

        if (code === 0 || code === 39) current = '#e8e8ef';
        if (code >= 30 && code <= 37) current = ANSI_COLORS[code - 30];
        if (code >= 90 && code <= 97) current = ANSI_BRIGHT_COLORS[code - 90];
        if (code === 38 && codes[index + 1] === 5 && Number.isFinite(codes[index + 2])) {
            current = ansi256(codes[index + 2]);
            index += 2;
        }
    }

    return current;
}

function truncateAnsiLine(value: string, maxColumns: number): string {
    let visible = 0;
    let output = '';

    for (let index = 0; index < value.length;) {
        const escapeMatch = value.slice(index).match(/^\u001b\[[0-9;?]*[ -/]*[@-~]/);

        if (escapeMatch) {
            output += escapeMatch[0];
            index += escapeMatch[0].length;
            continue;
        }
        if (visible >= maxColumns - 1) {
            output += '…';
            break;
        }
        output += value[index];
        visible += 1;
        index += 1;
    }

    return output;
}

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function ansi256(value: number): string {
    if (value < 16) return [...ANSI_COLORS, ...ANSI_BRIGHT_COLORS][value] || '#e8e8ef';
    if (value >= 232) {
        const level = 8 + (value - 232) * 10;

        return rgb(level, level, level);
    }
    const normalized = value - 16;
    const r = Math.floor(normalized / 36) % 6;
    const g = Math.floor(normalized / 6) % 6;
    const b = normalized % 6;

    return rgb(channel(r), channel(g), channel(b));
}

function channel(value: number): number {
    return value === 0 ? 0 : 55 + value * 40;
}

function rgb(red: number, green: number, blue: number): string {
    return `#${hex(red)}${hex(green)}${hex(blue)}`;
}

function hex(value: number): string {
    return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');
}

const ANSI_COLORS = ['#1f2937', '#ef4444', '#22c55e', '#eab308', '#3b82f6', '#a855f7', '#14b8a6', '#e5e7eb'];
const ANSI_BRIGHT_COLORS = ['#6b7280', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#2dd4bf', '#f9fafb'];

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
