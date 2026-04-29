import { ChatInputCommandInteraction, Client, Message } from 'discord.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type DiscordSource = Message | ChatInputCommandInteraction;

interface ContextState {
    seenMessages: Set<string>;
    seenChannels: Set<string>;
    seenAttachments: Set<string>;
}

interface FormatOptions {
    downloadAttachments: boolean;
    state: ContextState;
}

const MAX_CONTEXT_CHARS = 32000;
const CURRENT_CHANNEL_LIMIT = 16;
const MENTIONED_CHANNEL_LIMIT = 20;
const FORUM_THREAD_LIMIT = 8;
const FORUM_THREAD_MESSAGE_LIMIT = 5;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS = 12000;
const MESSAGE_LINK_PATTERN = /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/g;
const CHANNEL_MENTION_PATTERN = /<#(\d+)>/g;
const TEXT_EXTENSIONS = new Set([
    '.txt',
    '.log',
    '.md',
    '.json',
    '.jsonl',
    '.csv',
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.lua',
    '.luau',
    '.toml',
    '.yaml',
    '.yml',
    '.xml',
    '.html',
    '.css',
    '.rs',
    '.py',
    '.go',
    '.java',
    '.cs',
    '.cpp',
    '.h'
]);

export async function collectDiscordContext(source: DiscordSource, client: Client, requestText: string): Promise<string> {
    const state: ContextState = {
        seenMessages: new Set(),
        seenChannels: new Set(),
        seenAttachments: new Set()
    };
    const sections: string[] = [];

    if (source instanceof Message) {
        const referenced = await fetchReferencedMessage(source, client);

        if (referenced) {
            addSection(sections, 'Referenced message', await formatMessage(referenced, { downloadAttachments: true, state }));
        }

        addSection(sections, 'Current message', await formatMessage(source, { downloadAttachments: true, state }));
    } else {
        const attachments = await collectInteractionAttachments(source, state);

        if (attachments) addSection(sections, 'Uploaded slash command files', attachments);
    }

    for (const link of extractMessageLinks(requestText)) {
        const message = await fetchMessageByIds(client, link.channelId, link.messageId);

        if (message) {
            addSection(sections, `Linked message ${link.url}`, await formatMessage(message, { downloadAttachments: true, state }));
        } else {
            addSection(sections, `Linked message ${link.url}`, 'Could not fetch this message. Check bot permissions and channel access.');
        }
    }

    const channelMentionIds = extractChannelMentionIds(requestText);

    for (const channelId of channelMentionIds) {
        const snapshot = await collectChannelSnapshot(client, channelId, MENTIONED_CHANNEL_LIMIT, state, true);

        addSection(sections, `Mentioned channel <#${channelId}>`, snapshot || 'Could not fetch this channel. Check bot permissions and channel access.');
    }

    const currentChannelId = getSourceChannelId(source);

    if (currentChannelId) {
        const snapshot = await collectChannelSnapshot(client, currentChannelId, CURRENT_CHANNEL_LIMIT, state, false);

        if (snapshot) addSection(sections, 'Current Discord context', snapshot);
    }

    return truncateContext(sections.join('\n\n'));
}

export async function collectTargetChannelContext(client: Client, channelId: string, threadLimit = 25, messageLimit = 8): Promise<string> {
    const state: ContextState = {
        seenMessages: new Set(),
        seenChannels: new Set(),
        seenAttachments: new Set()
    };

    return truncateContext(await collectChannelSnapshot(client, channelId, messageLimit, state, true, threadLimit));
}

export function withDiscordContext(prompt: string, context: string): string {
    if (!context.trim()) return prompt;

    return [
        'Use this Discord context when it is relevant to the request. It may include replied-to messages, linked messages, mentioned channels, thread/forum context, and attachment paths or URLs.',
        '',
        context,
        '',
        'User request:',
        prompt
    ].join('\n');
}

function addSection(sections: string[], title: string, body: string): void {
    const normalized = body.trim();

    if (!normalized) return;

    sections.push(`## ${title}\n${normalized}`);
}

function extractMessageLinks(text: string): { guildId: string; channelId: string; messageId: string; url: string }[] {
    const links: { guildId: string; channelId: string; messageId: string; url: string }[] = [];

    for (const match of text.matchAll(MESSAGE_LINK_PATTERN)) {
        links.push({
            guildId: match[1],
            channelId: match[2],
            messageId: match[3],
            url: match[0]
        });
    }

    return dedupeBy(links, link => `${link.channelId}:${link.messageId}`);
}

function extractChannelMentionIds(text: string): string[] {
    return [...new Set([...text.matchAll(CHANNEL_MENTION_PATTERN)].map(match => match[1]))];
}

function getSourceChannelId(source: DiscordSource): string | null {
    return 'channelId' in source ? source.channelId : null;
}

async function fetchReferencedMessage(message: Message, client: Client): Promise<Message | null> {
    if (!message.reference?.channelId || !message.reference.messageId) return null;

    return fetchMessageByIds(client, message.reference.channelId, message.reference.messageId);
}

async function fetchMessageByIds(client: Client, channelId: string, messageId: string): Promise<Message | null> {
    try {
        const channel = await client.channels.fetch(channelId);

        if (!hasMessages(channel)) return null;

        return await channel.messages.fetch(messageId);
    } catch {
        return null;
    }
}

async function collectChannelSnapshot(
    client: Client,
    channelId: string,
    limit: number,
    state: ContextState,
    includeForumThreads: boolean,
    forumThreadLimit = FORUM_THREAD_LIMIT
): Promise<string> {
    if (state.seenChannels.has(`${channelId}:${includeForumThreads ? 'full' : 'recent'}`)) return '';
    state.seenChannels.add(`${channelId}:${includeForumThreads ? 'full' : 'recent'}`);

    try {
        const channel = await client.channels.fetch(channelId);

        if (!channel) return '';

        if (isForumChannel(channel) && includeForumThreads) {
            return collectForumSnapshot(channel, state, forumThreadLimit);
        }

        if (!hasMessages(channel)) {
            return formatChannelHeader(channel);
        }

        const messages = await channel.messages.fetch({ limit });
        const lines = await Promise.all([...messages.values()].reverse().map(message => formatMessage(message, {
            downloadAttachments: true,
            state
        })));
        const header = formatChannelHeader(channel);

        return [header, ...lines.filter(Boolean)].filter(Boolean).join('\n\n');
    } catch {
        return '';
    }
}

async function collectForumSnapshot(channel: any, state: ContextState, threadLimit = FORUM_THREAD_LIMIT): Promise<string> {
    const parts = [formatChannelHeader(channel)];
    const tagNames = getForumTagNames(channel);

    try {
        const threads = await fetchForumThreads(channel, threadLimit);

        for (const thread of threads) {
            const messages = hasMessages(thread)
                ? [...(await thread.messages.fetch({ limit: FORUM_THREAD_MESSAGE_LIMIT })).values()].reverse()
                : [];
            const formatted = await Promise.all(messages.map(message => formatMessage(message, {
                downloadAttachments: true,
                state
            })));
            const metadata = formatThreadMetadata(thread, tagNames);

            parts.push([
                `### Forum thread: ${thread.name}`,
                `URL: ${thread.url || ''}`,
                metadata,
                ...formatted.filter(Boolean)
            ].filter(Boolean).join('\n'));
        }
    } catch {
        parts.push('Could not fetch active forum threads.');
    }

    return parts.join('\n\n');
}

async function fetchForumThreads(channel: any, limit: number): Promise<any[]> {
    const threads: any[] = [];

    try {
        const active = await channel.threads.fetchActive();
        threads.push(...active.threads.values());
    } catch {}

    for (const type of ['public', 'private']) {
        try {
            const archived = await channel.threads.fetchArchived({ type, limit });
            threads.push(...archived.threads.values());
        } catch {}
    }

    return dedupeBy(threads, thread => thread.id)
        .sort((a, b) => Number(b.lastMessageId || b.id || 0) - Number(a.lastMessageId || a.id || 0))
        .slice(0, limit);
}

async function formatMessage(message: Message, options: FormatOptions): Promise<string> {
    const messageKey = `${message.channelId}:${message.id}`;

    if (options.state.seenMessages.has(messageKey)) return '';
    options.state.seenMessages.add(messageKey);

    const author = message.author
        ? `${message.author.tag}${message.author.bot ? ' (bot)' : ''} (${message.author.id})`
        : 'Unknown author';
    const channelName = getChannelName(message.channel);
    const timestamp = message.createdAt.toISOString();
    const content = cleanText(message.content || '[no text]');
    const attachments = await Promise.all([...message.attachments.values()].map(attachment => formatAttachment(attachment, message.id, options)));
    const reply = message.reference?.messageId
        ? `Replying to message ${message.reference.messageId}`
        : '';

    return [
        `[${timestamp}] ${author} in ${channelName}`,
        message.url,
        reply,
        content,
        ...attachments.filter(Boolean)
    ].filter(Boolean).join('\n');
}

async function formatAttachment(attachment: any, messageId: string, options: FormatOptions): Promise<string> {
    const name = attachment.name || attachment.id || 'attachment';
    const contentType = attachment.contentType || 'unknown';
    const size = Number(attachment.size || 0);
    const parts = [`Attachment: ${name} (${contentType}, ${size} bytes)`, `URL: ${attachment.url}`];

    if (!options.downloadAttachments || !attachment.url || !attachment.id || options.state.seenAttachments.has(attachment.id)) {
        return parts.join('\n');
    }

    options.state.seenAttachments.add(attachment.id);

    if (!Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
        parts.push('Local copy: skipped due to size limit');
        return parts.join('\n');
    }

    const stored = await storeAttachment(attachment, messageId);

    if (stored.path) parts.push(`Local copy: ${stored.path}`);
    if (stored.text) parts.push(`Text preview:\n${stored.text}`);

    return parts.join('\n');
}

async function collectInteractionAttachments(interaction: ChatInputCommandInteraction, state: ContextState): Promise<string> {
    const attachments = ['file', 'file2', 'file3']
        .map(name => safeGetAttachment(interaction, name))
        .filter(Boolean);

    if (attachments.length === 0) return '';

    const formatted = await Promise.all(attachments.map(attachment => formatAttachment(attachment, interaction.id, {
        downloadAttachments: true,
        state
    })));

    return formatted.filter(Boolean).join('\n\n');
}

function safeGetAttachment(interaction: ChatInputCommandInteraction, name: string): any {
    try {
        return interaction.options.getAttachment(name);
    } catch {
        return null;
    }
}

async function storeAttachment(attachment: any, messageId: string): Promise<{ path?: string; text?: string }> {
    try {
        const response = await fetch(attachment.url);

        if (!response.ok) return {};

        const buffer = Buffer.from(await response.arrayBuffer());
        const directory = path.join(process.cwd(), 'data', 'context-attachments');
        const fileName = `${messageId}-${attachment.id}-${safeFileName(attachment.name || 'attachment')}`;
        const filePath = path.join(directory, fileName);

        await mkdir(directory, { recursive: true });
        await writeFile(filePath, buffer);

        return {
            path: filePath,
            text: isTextAttachment(attachment) ? buffer.toString('utf8').slice(0, MAX_ATTACHMENT_TEXT_CHARS) : undefined
        };
    } catch {
        return {};
    }
}

function getForumTagNames(channel: any): Map<string, string> {
    const tags = new Map<string, string>();

    for (const tag of channel?.availableTags || []) {
        if (tag?.id && tag?.name) tags.set(tag.id, tag.name);
    }

    return tags;
}

function formatThreadMetadata(thread: any, tagNames: Map<string, string>): string {
    const details = [];
    const appliedTags = Array.isArray(thread.appliedTags)
        ? thread.appliedTags.map((tagId: string) => tagNames.get(tagId) || tagId)
        : [];

    if (thread.ownerId) details.push(`owner ${thread.ownerId}`);
    if (thread.archived !== undefined) details.push(thread.archived ? 'archived' : 'active');
    if (thread.locked !== undefined) details.push(thread.locked ? 'locked' : 'unlocked');
    if (thread.messageCount !== undefined) details.push(`${thread.messageCount} messages`);
    if (thread.memberCount !== undefined) details.push(`${thread.memberCount} members`);
    if (appliedTags.length > 0) details.push(`tags ${appliedTags.join(', ')}`);

    return details.length > 0 ? `Metadata: ${details.join(', ')}` : '';
}

function formatChannelHeader(channel: any): string {
    const name = getChannelName(channel);
    const id = channel?.id ? ` (${channel.id})` : '';
    const type = channel?.type !== undefined ? `type ${channel.type}` : 'unknown type';
    const url = channel?.url ? `\nURL: ${channel.url}` : '';

    return `Channel: ${name}${id}, ${type}${url}`;
}

function hasMessages(channel: any): channel is { messages: { fetch: (options: any) => Promise<any> } } {
    return Boolean(channel?.messages && typeof channel.messages.fetch === 'function');
}

function isForumChannel(channel: any): boolean {
    return Boolean(channel?.threads && typeof channel.threads.fetchActive === 'function' && channel?.type === 15);
}

function getChannelName(channel: any): string {
    if (!channel) return 'unknown channel';
    if (typeof channel.name === 'string') return `#${channel.name}`;
    if (channel.id) return `channel ${channel.id}`;

    return 'unknown channel';
}

function isTextAttachment(attachment: any): boolean {
    const contentType = String(attachment.contentType || '').toLowerCase();
    const extension = path.extname(String(attachment.name || '')).toLowerCase();

    return contentType.startsWith('text/')
        || contentType.includes('json')
        || contentType.includes('xml')
        || TEXT_EXTENSIONS.has(extension);
}

function safeFileName(name: string): string {
    const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);

    return cleaned || 'attachment';
}

function cleanText(text: string): string {
    return text.replace(/\u0000/g, '').trim();
}

function truncateContext(text: string): string {
    if (text.length <= MAX_CONTEXT_CHARS) return text;

    return `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Discord context truncated at ${MAX_CONTEXT_CHARS} characters]`;
}

function dedupeBy<T>(items: T[], getKey: (item: T) => string): T[] {
    const seen = new Set<string>();
    const results: T[] = [];

    for (const item of items) {
        const key = getKey(item);

        if (seen.has(key)) continue;
        seen.add(key);
        results.push(item);
    }

    return results;
}
