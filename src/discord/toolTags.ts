export interface ToolTagDefinition {
    name: string;
    label: string;
    description: string;
    aliases: string[];
    guidance: string;
}

export const TOOL_TAGS: ToolTagDefinition[] = [
    {
        name: 'browser-use',
        label: 'Browser Use',
        description: 'Inspect, test, click, type, or screenshot browser pages.',
        aliases: ['browser', 'browseruse', 'browser-use', 'browser use'],
        guidance: 'Use the Browser Use plugin for browser navigation, screenshots, clicking, typing, and local web app testing when it is available.'
    },
    {
        name: 'computer-use',
        label: 'Computer Use',
        description: 'Control desktop apps when a task needs the local GUI.',
        aliases: ['computer', 'computeruse', 'computer-use', 'computer use', 'cua'],
        guidance: 'Use the computer-use plugin for desktop app control when the task needs GUI automation and the plugin is available.'
    },
    {
        name: 'github',
        label: 'GitHub',
        description: 'Inspect repositories, PRs, issues, checks, and reviews.',
        aliases: ['github', 'gh'],
        guidance: 'Use the GitHub plugin or gh CLI for repository, pull request, issue, and CI workflows when available.'
    },
    {
        name: 'figma',
        label: 'Figma',
        description: 'Inspect Figma designs and design-system context.',
        aliases: ['figma'],
        guidance: 'Use the Figma plugin for design inspection and design-system workflows when available.'
    },
    {
        name: 'google-drive',
        label: 'Google Drive',
        description: 'Work with Drive, Docs, Sheets, and Slides.',
        aliases: ['drive', 'google-drive', 'google drive', 'gdrive'],
        guidance: 'Use the Google Drive plugin for Drive, Docs, Sheets, and Slides workflows when available.'
    },
    {
        name: 'gmail',
        label: 'Gmail',
        description: 'Find, summarize, draft, or send Gmail messages.',
        aliases: ['gmail', 'mail'],
        guidance: 'Use the Gmail plugin for email search, drafting, and mailbox workflows when available.'
    },
    {
        name: 'google-calendar',
        label: 'Google Calendar',
        description: 'Review availability and manage calendar events.',
        aliases: ['calendar', 'google-calendar', 'google calendar', 'gcal'],
        guidance: 'Use the Google Calendar plugin for schedule, availability, and event workflows when available.'
    },
    {
        name: 'linear',
        label: 'Linear',
        description: 'Find and reference Linear issues and projects.',
        aliases: ['linear'],
        guidance: 'Use the Linear plugin for issue and project workflows when available.'
    },
    {
        name: 'notion',
        label: 'Notion',
        description: 'Use Notion pages, tasks, and knowledge bases.',
        aliases: ['notion'],
        guidance: 'Use the Notion plugin for Notion research, planning, and knowledge-capture workflows when available.'
    },
    {
        name: 'slack',
        label: 'Slack',
        description: 'Review Slack messages and draft replies.',
        aliases: ['slack'],
        guidance: 'Use the Slack plugin for Slack search, summaries, and reply drafting when available.'
    },
    {
        name: 'teams',
        label: 'Teams',
        description: 'Review Teams chats, channels, and Planner tasks.',
        aliases: ['teams', 'msteams', 'microsoft-teams', 'microsoft teams'],
        guidance: 'Use the Teams plugin for Microsoft Teams chat, channel, and Planner workflows when available.'
    }
];

const tagByAlias = new Map<string, ToolTagDefinition>();

for (const tag of TOOL_TAGS) {
    tagByAlias.set(normalizeToolTag(tag.name), tag);

    for (const alias of tag.aliases) {
        tagByAlias.set(normalizeToolTag(alias), tag);
    }
}

export function parseToolTags(...values: Array<string | null | undefined>): ToolTagDefinition[] {
    const tags: ToolTagDefinition[] = [];
    const seen = new Set<string>();

    for (const value of values) {
        for (const token of getToolTagTokens(value || '')) {
            const tag = tagByAlias.get(normalizeToolTag(token));

            if (!tag || seen.has(tag.name)) continue;
            seen.add(tag.name);
            tags.push(tag);
        }
    }

    return tags;
}

export function withToolTagGuidance(prompt: string, tags: ToolTagDefinition[]): string {
    if (tags.length === 0) return prompt;

    return [
        prompt,
        '',
        'Requested tool tags:',
        ...tags.map(tag => `- @${tag.name}: ${tag.guidance}`),
        'If a requested tool is unavailable, say so briefly and use the best available fallback.'
    ].join('\n');
}

function getToolTagTokens(value: string): string[] {
    const explicitTags = [...value.matchAll(/@([a-z][a-z0-9_-]{1,40})/gi)].map(match => match[1]);
    const listTags = value
        .split(/[,;\n]/)
        .map(item => item.trim())
        .filter(item => /^[a-z][a-z0-9 _-]{1,40}$/i.test(item));

    return [...explicitTags, ...listTags];
}

function normalizeToolTag(value: string): string {
    return value
        .toLowerCase()
        .replace(/^@+/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
