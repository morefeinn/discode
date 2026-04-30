import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { CodexRunner } from './codex/runner.js';
import { AccountRouter } from './accounts/router.js';
import { DiscordCodexBridge } from './discord/bridge.js';
import { registerSlashCommands } from './discord/commands.js';
import { checkForUpdate, formatUpdateNotice } from './update/checker.js';

const config = loadConfig();
const colorEnabled = process.stdout.isTTY && process.env.NO_COLOR !== '1' && process.env.NO_COLOR !== 'true';
const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string };
const color = (value: string, code: string): string => colorEnabled ? `${code}${value}\x1b[0m` : value;
const ok = (value: string): void => console.log(`${color('ok', '\x1b[32m')} ${value}`);
const info = (value: string): void => console.log(`${color('info', '\x1b[36m')} ${value}`);
const warn = (value: string): void => console.warn(`${color('warn', '\x1b[33m')} ${value}`);
const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, '');
const row = (label: string, value: string): string => `${color(label.padEnd(14), '\x1b[90m')} ${value}`;

function panel(title: string, rows: string[]): void {
    const width = Math.max(stripAnsi(title).length, ...rows.map(item => stripAnsi(item).length), 28);

    console.log(color(`+-- ${title} ${'-'.repeat(Math.max(0, width - stripAnsi(title).length - 1))}+`, '\x1b[36m'));
    for (const item of rows) {
        console.log(`| ${item}${' '.repeat(Math.max(0, width - stripAnsi(item).length))} |`);
    }
    console.log(color(`+${'-'.repeat(width + 2)}+`, '\x1b[36m'));
}

if (!config.token) {
    throw new Error('DISCORD_TOKEN is required. Add it to .env or the process environment.');
}

if (!config.clientId) {
    throw new Error('DISCORD_CLIENT_ID is required. Add it to .env or the process environment.');
}

if (config.allowedUserIds.length === 0) {
    throw new Error('ALLOWED_USER_IDS is required. Add at least one Discord user id to .env or the process environment.');
}

const accounts = new AccountRouter(config.accountsPath, config.codexAuthPath);
const runner = new CodexRunner(config, accounts);
const bridge = new DiscordCodexBridge(config, runner, accounts);
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, async () => {
    const botName = client.user?.username || 'Discode';

    try {
        const registered = await registerSlashCommands(config, botName, [...client.guilds.cache.keys()]);
        bridge.setBotIdentity(botName, registered.primaryName);
        panel(`Discode ${packageJson.version || ''}`.trim(), [
            row('gateway', color(`connected as ${client.user?.tag}`, '\x1b[32m')),
            row('command', `/${registered.primaryName}`),
            row('harnesses', await providerSummary()),
            row('usage', `${formatNumber(readStoredTokenUsage())} tokens`)
        ]);
        const updateStatus = await checkForUpdate(process.cwd());
        const updateNotice = formatUpdateNotice(updateStatus);

        if (updateNotice) info(updateNotice);
        await bridge.recoverRunningRuns(client);
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }
});

async function providerSummary(): Promise<string> {
    const accountProviders = (await accounts.listAccounts())
        .map(account => account.provider)
        .filter(Boolean);
    const providers = Array.from(new Set([
        config.defaultProvider,
        ...accountProviders
    ])).filter(Boolean);

    return providers.join(', ') || 'codex';
}

function readStoredTokenUsage(): number {
    try {
        const parsed = JSON.parse(readFileSync(path.resolve('data', 'token-stats.json'), 'utf8'));
        const conversations = Object.values(parsed?.conversations || {}) as { totalTokens?: number }[];

        return conversations.reduce((sum, item) => sum + (item.totalTokens || 0), 0);
    } catch {
        return 0;
    }
}

function formatNumber(value: number): string {
    return value.toLocaleString('en-US');
}

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
        await bridge.handleAutocomplete(interaction);
        return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
        try {
            await bridge.handleComponent(interaction);
        } catch (error: any) {
            console.error('Component interaction failed:', error);
            const content = `Control failed: ${error?.message || String(error)}`;

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(content).catch(() => undefined);
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
            }
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        try {
            await bridge.handleModal(interaction);
        } catch (error: any) {
            console.error('Modal interaction failed:', error);
            const content = `Modal failed: ${error?.message || String(error)}`;

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(content).catch(() => undefined);
            } else {
                await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        await bridge.handleInteraction(interaction);
    } catch (error: any) {
        console.error('Interaction failed:', error);
        const content = `Command failed: ${error?.message || String(error)}`;

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(content).catch(() => undefined);
        } else {
            await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
    }
});

client.on(Events.MessageCreate, async message => {
    try {
        await bridge.handleMessage(message, client);
    } catch (error) {
        console.error('Message handling failed:', error);
    }
});

client.on('error', error => {
    warn(`Discord client error: ${String(error)}`);
});

process.on('unhandledRejection', error => {
    warn(`Unhandled rejection: ${String(error)}`);
});

await client.login(config.token);
