import sharp from 'sharp';

export interface WorkspaceCardProject {
    index: number;
    name: string;
    workspace: string;
    active: boolean;
}

export interface WorkspaceCardGit {
    branch: string;
    changes: number;
    ahead: number;
    behind: number;
    clean: boolean;
    available: boolean;
}

export interface WorkspaceCardData {
    activeName: string;
    activeWorkspace: string;
    git: WorkspaceCardGit;
    projects: WorkspaceCardProject[];
    generatedAt: string;
}

const WIDTH = 1100;
const HEIGHT = 660;

export async function renderWorkspaceCard(data: WorkspaceCardData): Promise<Buffer> {
    return sharp(Buffer.from(renderSvg(data))).png().toBuffer();
}

function renderSvg(data: WorkspaceCardData): string {
    const projects = data.projects.slice(0, 6).map((project, index) => projectRow(project, 326 + index * 46)).join('');

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
        '<rect x="1" y="1" width="1098" height="658" rx="34" fill="#202123" stroke="#343541" stroke-width="2"/>',
        text('Workspace', 70, 82, 40, 360, '#f7f7f8', 800),
        text(data.activeName || 'Default', 70, 144, 34, 500, '#f7f7f8', 760),
        text(shortPath(data.activeWorkspace), 70, 184, 22, 900, '#8e8ea0', 540),
        gitBlock(data.git),
        text('Saved directories', 70, 292, 24, 360, '#f7f7f8', 720),
        projects || text('No saved directories yet.', 70, 354, 22, 420, '#8e8ea0', 540),
        text(data.generatedAt, 1030, 604, 20, 360, '#8e8ea0', 500, 'end'),
        '</svg>'
    ].join('');
}

function gitBlock(git: WorkspaceCardGit): string {
    const state = !git.available ? 'Not a git repo' : git.clean ? 'Clean' : `${git.changes.toLocaleString('en-US')} changed`;
    const sync = git.available ? `Ahead ${git.ahead.toLocaleString('en-US')} · Behind ${git.behind.toLocaleString('en-US')}` : 'Git metadata unavailable';

    return [
        '<rect x="70" y="220" width="960" height="44" rx="16" fill="#26272b" stroke="#343541" stroke-width="1"/>',
        text('Git', 96, 249, 20, 80, '#8e8ea0', 620),
        text(git.branch || 'unknown', 170, 249, 20, 360, '#f7f7f8', 680),
        text(state, 570, 249, 20, 220, git.clean ? '#10a37f' : '#f7f7f8', 680),
        text(sync, 1004, 249, 20, 320, '#8e8ea0', 540, 'end')
    ].join('');
}

function projectRow(project: WorkspaceCardProject, y: number): string {
    return [
        `<line x1="70" y1="${y - 30}" x2="1030" y2="${y - 30}" stroke="#30313a" stroke-width="1"/>`,
        text(project.active ? `${project.index}. ${project.name}` : `${project.index}. ${project.name}`, 70, y, 22, 340, project.active ? '#f7f7f8' : '#c5c5d2', project.active ? 760 : 560),
        text(shortPath(project.workspace), 430, y, 20, 580, '#8e8ea0', 500)
    ].join('');
}

function shortPath(value: string): string {
    return value.replace(/^\/Users\/apple\b/, '~');
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
