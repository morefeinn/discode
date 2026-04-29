import sharp from 'sharp';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import { CodexUsage } from '../codex/runner.js';

const WIDTH = 920;
const HEIGHT = 320;
const CARD_X = 46;
const CARD_Y = 16;
const CARD_WIDTH = 828;
const CARD_HEIGHT = 288;
const THINKING_FRAMES = 60;
const THINKING_FRAME_DELAY_MS = 32;

export async function renderThinkingGif(task: string, agentName: string): Promise<Buffer> {
    const frames = await Promise.all(Array.from({ length: THINKING_FRAMES }, (_value, index) => renderRaw(renderThinkingSvg(task, cleanAgentName(agentName), index), WIDTH, HEIGHT)));
    const gif = GIFEncoder();

    for (const frame of frames) {
        const palette = quantize(frame, 96, { format: 'rgba4444', oneBitAlpha: true });
        const indexed = applyPalette(frame, palette, 'rgba4444');

        gif.writeFrame(indexed, WIDTH, HEIGHT, {
            palette,
            delay: THINKING_FRAME_DELAY_MS,
            repeat: 0,
            transparent: true,
            transparentIndex: indexed[0]
        });
    }
    gif.finish();

    return Buffer.from(gif.bytes());
}

export async function renderLimitCard(message: string, resetAt: string): Promise<Buffer> {
    return sharp(Buffer.from([
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        card(),
        text('Usage limit reached', 54, 82, 38, 620, '#f7f7f8', 800),
        text(resetAt ? `Resets ${resetAt}` : 'Switch accounts or try again later.', 54, 126, 23, 760, '#c5c5d2', 560),
        text(clean(message), 54, 180, 22, 800, '#8e8ea0', 520),
        '</svg>'
    ].join(''))).png().toBuffer();
}

export async function renderAccessRequestCard(scope: string): Promise<Buffer> {
    return sharp(Buffer.from([
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        card(),
        text('Access needed', 54, 86, 38, 620, '#f7f7f8', 800),
        text(clean(scope), 54, 136, 24, 780, '#c5c5d2', 560),
        text('Approve once to continue this run.', 54, 202, 22, 720, '#8e8ea0', 520),
        '</svg>'
    ].join(''))).png().toBuffer();
}

export async function renderUsageStatsCard(usage: CodexUsage): Promise<Buffer> {
    const uncachedInput = Math.max(0, (usage.inputTokens || 0) - (usage.cachedInputTokens || 0));
    const values = [
        { label: 'Input', value: uncachedInput, color: '#10a37f' },
        { label: 'Output', value: usage.outputTokens || 0, color: '#3b82f6' },
        { label: 'Reasoning', value: usage.reasoningOutputTokens || 0, color: '#d4a72c' }
    ].filter(item => item.value > 0);
    const total = values.reduce((sum, item) => sum + item.value, 0);
    const slices = pieSlices(values, total, 156, 162, 78);
    const rows = values.map((item, index) => [
        `<rect x="340" y="${112 + index * 38}" width="18" height="18" rx="5" fill="${item.color}"/>`,
        text(item.label, 372, 129 + index * 38, 20, 180, '#f7f7f8', 620),
        text(format(item.value), 650, 129 + index * 38, 20, 170, '#c5c5d2', 560, 'end')
    ].join('')).join('');

    return sharp(Buffer.from([
        '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="320" viewBox="0 0 760 320">',
        '<rect x="1" y="1" width="758" height="318" rx="28" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('Token Usage Stats', 54, 62, 32, 320, '#f7f7f8', 800),
        text(`${format(total)} tokens`, 650, 62, 22, 240, '#c5c5d2', 620, 'end'),
        total > 0 ? slices : '<circle cx="156" cy="162" r="78" fill="#343541"/>',
        '<circle cx="156" cy="162" r="48" fill="#202123"/>',
        rows || text('No token stats available.', 340, 152, 22, 320, '#8e8ea0', 560),
        '</svg>'
    ].join(''))).png().toBuffer();
}

function renderThinkingSvg(task: string, agentName: string, frame: number): string {
    const dotFrame = Math.floor((frame / THINKING_FRAMES) * 3);
    const dots = [0, 1, 2].map(index => {
        const active = index === dotFrame;
        const radius = active ? 7 : 5;
        const color = active ? '#f7f7f8' : '#7d7d8a';

        return `<circle cx="${WIDTH / 2 - 24 + index * 24}" cy="222" r="${radius}" fill="${color}"/>`;
    }).join('');
    const progress = frame / (THINKING_FRAMES - 1);
    const glareX = 84 + progress * 760;
    const taskText = clean(task);

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<defs>',
        '<linearGradient id="task-glare-gradient" x1="0" y1="0" x2="1" y2="0">',
        '<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>',
        '<stop offset="0.38" stop-color="#ffffff" stop-opacity="0"/>',
        '<stop offset="0.5" stop-color="#ffffff" stop-opacity="0.72"/>',
        '<stop offset="0.62" stop-color="#ffffff" stop-opacity="0"/>',
        '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>',
        '</linearGradient>',
        '<mask id="task-text-mask" maskUnits="userSpaceOnUse">',
        '<rect x="0" y="0" width="920" height="320" fill="#000"/>',
        text(taskText, WIDTH / 2, 164, 23, 700, '#fff', 560, 'middle'),
        '</mask>',
        '</defs>',
        thinkingCard(),
        text(`${agentName} is thinking`, WIDTH / 2, 116, 38, 560, '#f7f7f8', 800, 'middle'),
        text(taskText, WIDTH / 2, 164, 23, 700, '#c5c5d2', 560, 'middle'),
        `<polygon points="${glareX},132 ${glareX + 170},132 ${glareX + 126},184 ${glareX - 44},184" fill="url(#task-glare-gradient)" mask="url(#task-text-mask)"/>`,
        dots,
        '</svg>'
    ].join('');
}

async function renderRaw(svg: string, width: number, height: number): Promise<Buffer> {
    return sharp(Buffer.from(svg)).raw().ensureAlpha().resize(width, height).toBuffer();
}

function card(): string {
    return `<rect x="1" y="1" width="${WIDTH - 2}" height="${HEIGHT - 2}" rx="28" fill="#202123" stroke="#343541" stroke-width="2"/>`;
}

function thinkingCard(): string {
    return `<rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="30" fill="#202123" stroke="#343541" stroke-width="2"/>`;
}

function pieSlices(values: { value: number; color: string }[], total: number, cx: number, cy: number, radius: number): string {
    let angle = -90;

    return values.map(item => {
        const span = total > 0 ? (item.value / total) * 360 : 0;
        const path = slicePath(cx, cy, radius, angle, angle + span, item.color);

        angle += span;
        return path;
    }).join('');
}

function slicePath(cx: number, cy: number, radius: number, startAngle: number, endAngle: number, color: string): string {
    if (endAngle - startAngle >= 359.9) {
        return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`;
    }
    const start = point(cx, cy, radius, endAngle);
    const end = point(cx, cy, radius, startAngle);
    const large = endAngle - startAngle > 180 ? 1 : 0;

    return `<path d="M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 0 ${end.x} ${end.y} Z" fill="${color}"/>`;
}

function point(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
    const radians = (angle * Math.PI) / 180;

    return {
        x: cx + radius * Math.cos(radians),
        y: cy + radius * Math.sin(radians)
    };
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

function clean(value: string): string {
    return value.replace(/\s+/g, ' ').trim() || 'Working...';
}

function cleanAgentName(value: string): string {
    return value
        .replace(/[^\w\s.-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 28) || 'Agent';
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;

    return value.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '...';
}

function format(value: number): string {
    return value.toLocaleString('en-US');
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
