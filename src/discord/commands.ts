import {
    ApplicationIntegrationType,
    ChannelType,
    InteractionContextType,
    REST,
    Routes,
    SlashCommandBuilder,
    SlashCommandStringOption
} from 'discord.js';
import { BridgeConfig } from '../config.js';

export interface RegisteredSlashCommands {
    primaryName: string;
    names: string[];
}

export async function registerSlashCommands(config: BridgeConfig, botName: string, connectedGuildIds: string[] = []): Promise<RegisteredSlashCommands> {
    const commandName = resolveCommandName(config, botName);
    const displayName = cleanDisplayName(botName);
    const command = new SlashCommandBuilder()
        .setName(commandName)
        .setDescription(`Use ${displayName} to control local coding agents from Discord.`)
        .addSubcommand(subcommand => subcommand
            .setName('prompt')
            .setDescription('Send a prompt to the active agent.')
            .addStringOption(option => option
                .setName('prompt')
                .setDescription(`Prompt to send to ${displayName}.`)
                .setRequired(true))
            .addBooleanOption(option => option
                .setName('new')
                .setDescription(`Start a fresh ${displayName} conversation.`))
            .addStringOption(option => option
                .setName('workspace')
                .setDescription(`Working directory or saved project for ${displayName}.`)
                .setAutocomplete(true))
            .addStringOption(option => option
                .setName('model')
                .setDescription('Model override.'))
            .addAttachmentOption(option => option
                .setName('file')
                .setDescription(`File or screenshot for ${displayName} to review.`))
            .addStringOption(option => addToolOption(option))
            .addBooleanOption(option => option
                .setName('dangerous')
                .setDescription(`Use ${displayName} bypass mode for this run.`)))
        .addSubcommand(subcommand => subcommand
            .setName('new')
            .setDescription('Start a fresh agent conversation in this channel.')
            .addStringOption(option => option
                .setName('prompt')
                .setDescription('Optional first prompt.'))
            .addStringOption(option => option
                .setName('workspace')
                .setDescription(`Working directory or saved project for ${displayName}.`)
                .setAutocomplete(true))
            .addStringOption(option => option
                .setName('model')
                .setDescription('Model override.'))
            .addAttachmentOption(option => option
                .setName('file')
                .setDescription(`File or screenshot for ${displayName} to review.`))
            .addStringOption(option => addToolOption(option)))
        .addSubcommand(subcommand => subcommand
            .setName('init')
            .setDescription('Initialize agent instructions for the active workspace.')
            .addStringOption(option => option
                .setName('workspace')
                .setDescription(`Working directory or saved project for ${displayName}.`)
                .setAutocomplete(true))
            .addStringOption(option => option
                .setName('model')
                .setDescription('Model override.'))
            .addStringOption(option => addToolOption(option))
            .addBooleanOption(option => option
                .setName('dangerous')
                .setDescription(`Use ${displayName} bypass mode for this run.`)))
        .addSubcommand(subcommand => subcommand
            .setName('review')
            .setDescription('Run an agent code review.')
            .addStringOption(option => option
                .setName('scope')
                .setDescription('What to review.')
                .setRequired(true)
                .addChoices(
                    { name: 'Uncommitted changes', value: 'uncommitted' },
                    { name: 'Against base branch', value: 'base' },
                    { name: 'Commit', value: 'commit' }
                ))
            .addStringOption(option => option
                .setName('ref')
                .setDescription('Base branch or commit SHA.'))
            .addStringOption(option => option
                .setName('instructions')
                .setDescription('Optional review instructions.'))
            .addStringOption(option => option
                .setName('workspace')
                .setDescription(`Working directory or saved project for ${displayName}.`)
                .setAutocomplete(true))
            .addStringOption(option => option
                .setName('model')
                .setDescription('Model override.'))
            .addAttachmentOption(option => option
                .setName('file')
                .setDescription('File or screenshot to include in review context.'))
            .addStringOption(option => addToolOption(option))
            .addBooleanOption(option => option
                .setName('dangerous')
                .setDescription(`Use ${displayName} bypass mode for this run.`)))
        .addSubcommand(subcommand => subcommand
            .setName('triage')
            .setDescription('Triage a Discord forum, thread, or channel with the agent.')
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Forum, thread, or channel to review.')
                .setRequired(true)
                .addChannelTypes(
                    ChannelType.GuildForum,
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement,
                    ChannelType.PublicThread,
                    ChannelType.PrivateThread,
                    ChannelType.AnnouncementThread
                ))
            .addStringOption(option => option
                .setName('focus')
                .setDescription('What to prioritize while triaging.'))
            .addIntegerOption(option => option
                .setName('limit')
                .setDescription('Maximum forum threads or recent messages to inspect.')
                .setMinValue(1)
                .setMaxValue(50))
            .addStringOption(option => option
                .setName('workspace')
                .setDescription(`Working directory or saved project for ${displayName}.`)
                .setAutocomplete(true))
            .addStringOption(option => option
                .setName('model')
                .setDescription('Model override.'))
            .addStringOption(option => addToolOption(option))
            .addBooleanOption(option => option
                .setName('dangerous')
                .setDescription(`Use ${displayName} bypass mode for this run.`)))
        .addSubcommand(subcommand => subcommand
            .setName('usage')
            .setDescription('Show account usage and switch accounts.'))
        .addSubcommand(subcommand => subcommand
            .setName('settings')
            .setDescription('Open Discode runtime and permission settings.'))
        .addSubcommand(subcommand => subcommand
            .setName('workspace')
            .setDescription('Open the project directory dashboard.'))
        .addSubcommand(subcommand => subcommand
            .setName('mcp')
            .setDescription(`Open the ${displayName} MCP dashboard.`))
        .addSubcommand(subcommand => subcommand
            .setName('terminal')
            .setDescription(`Open a terminal surface for the active ${displayName} workspace.`))
        .addSubcommand(subcommand => subcommand
            .setName('reset')
            .setDescription(`Clear the ${displayName} conversation mapping for this channel.`))
        .addSubcommand(subcommand => subcommand
            .setName('archive')
            .setDescription(`Archive the current ${displayName} Discord thread.`))
        .addSubcommand(subcommand => subcommand
            .setName('project')
            .setDescription('Open the project directory dashboard.'))
        .addSubcommand(subcommand => subcommand
            .setName('chats')
            .setDescription(`List saved ${displayName} chats.`))
        .addSubcommand(subcommand => subcommand
            .setName('conversations')
            .setDescription(`Open a dropdown of saved ${displayName} conversations.`))
        .addSubcommand(subcommand => subcommand
            .setName('load')
            .setDescription(`Load an existing ${displayName} chat in this Discord thread/channel.`)
            .addStringOption(option => option
                .setName('chat')
                .setDescription('Chat index, name, Discord thread id, or agent thread id.')
                .setRequired(true)
                .setAutocomplete(true)));

    const initCommand = new SlashCommandBuilder()
        .setName('init')
        .setDescription('Initialize agent instructions for the active workspace.')
        .addStringOption(option => option
            .setName('workspace')
            .setDescription(`Working directory or saved project for ${displayName}.`)
            .setAutocomplete(true))
        .addStringOption(option => option
            .setName('model')
            .setDescription('Model override.'))
        .addStringOption(option => addToolOption(option))
        .addBooleanOption(option => option
            .setName('dangerous')
            .setDescription(`Use ${displayName} bypass mode for this run.`));
    const rest = new REST({ version: '10' }).setToken(config.token);
    const guildId = process.env.DISCORD_GUILD_ID?.trim();
    const body = commandName === 'init' ? [command.toJSON()] : [command.toJSON(), initCommand.toJSON()];
    const commandNames = body.map(item => `/${item.name}`);
    const globalBody = body.map(item => ({
        ...item,
        contexts: [
            InteractionContextType.Guild,
            InteractionContextType.BotDM,
            InteractionContextType.PrivateChannel
        ],
        integration_types: [
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ]
    }));
    const botInstallBody = body.map(item => ({
        ...item,
        contexts: [
            InteractionContextType.Guild,
            InteractionContextType.BotDM
        ],
        integration_types: [
            ApplicationIntegrationType.GuildInstall
        ]
    }));

    try {
        await rest.put(Routes.applicationCommands(config.clientId), { body: globalBody });
    } catch (error) {
        console.warn('Global command registration with private-channel scope failed, retrying bot DM scope:', error);
        await rest.put(Routes.applicationCommands(config.clientId), { body: botInstallBody });
    }

    const guildIds = Array.from(new Set([guildId, ...connectedGuildIds].filter((value): value is string => Boolean(value))));

    for (const guildId of guildIds) {
        await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), { body });
    }

    return {
        primaryName: commandName,
        names: commandNames
    };
}

function addToolOption(option: SlashCommandStringOption): SlashCommandStringOption {
    return option
        .setName('tools')
        .setDescription('Tool tags, comma separated, like browser-use or computer-use.');
}

export function resolveCommandName(config: BridgeConfig, botName: string): string {
    return normalizeCommandName(config.commandName || botName);
}

function normalizeCommandName(value: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);

    return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : 'discode';
}

function cleanDisplayName(value: string): string {
    return value
        .replace(/[^\w\s.-]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40) || 'Discode';
}
