import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { CodexRunner } from './codex/runner.js';
import { AccountRouter } from './accounts/router.js';
import { DiscordCodexBridge } from './discord/bridge.js';
import { registerSlashCommands } from './discord/commands.js';

const config = loadConfig();

if (!config.token) {
    throw new Error('DISCORD_TOKEN is required. Add it to .env or the process environment.');
}

if (!config.clientId) {
    throw new Error('DISCORD_CLIENT_ID is required. Add it to .env or the process environment.');
}

if (config.allowedUserIds.length === 0) {
    throw new Error('ALLOWED_USER_IDS is required. Add at least one Discord user id to .env or the process environment.');
}

const accounts = new AccountRouter(config.accountsPath, config.codexAuthPath, config.legacySwitcherImportPath);
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
    console.log(`Discode logged in as ${client.user?.tag}`);

    try {
        const registered = await registerSlashCommands(config, botName, [...client.guilds.cache.keys()]);
        bridge.setBotIdentity(botName, registered.primaryName);
        console.log(`Registered slash commands: ${registered.names.join(', ')}.`);
        await bridge.recoverRunningRuns(client);
    } catch (error) {
        console.error('Failed to register slash commands:', error);
    }
});

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
    console.warn('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.warn('Unhandled rejection:', error);
});

await client.login(config.token);
