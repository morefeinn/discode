export function sanitizeDiscordText(text: string): string {
    return text
        .replace(/@(everyone|here)/g, '@\u200b$1')
        .replace(/<@&(\d+)>/g, '<@&\u200b$1>');
}

export function splitDiscordText(text: string, limit = 1900): string[] {
    if (!text) return [''];
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let current = '';

    for (const line of text.split('\n')) {
        if ((current + line + '\n').length > limit) {
            if (current.trim()) chunks.push(current);
            current = '';
        }

        if (line.length > limit) {
            const forced = line.match(new RegExp(`.{1,${limit}}`, 'g')) || [];
            chunks.push(...forced.slice(0, -1));
            current = forced.at(-1) || '';
        } else {
            current += `${line}\n`;
        }
    }

    if (current.trim()) chunks.push(current);

    return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}

export function formatCodeBlock(text: string): string {
    const safeText = text.replace(/```/g, '` ` `');

    return `\`\`\`\n${safeText}\n\`\`\``;
}
