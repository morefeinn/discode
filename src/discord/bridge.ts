import {
    ActionRowBuilder,
    AttachmentBuilder,
    AutocompleteInteraction,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    Client,
    Message,
    MessageFlags,
    ModalBuilder,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    TextChannel,
    TextInputBuilder,
    TextInputStyle,
    ThreadAutoArchiveDuration
} from 'discord.js';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BridgeConfig } from '../config.js';
import { CodexReviewOptions, CodexRunResult, CodexRunner, CodexUsage } from '../codex/runner.js';
import { AccountRouter, AccountSummary } from '../accounts/router.js';
import { fetchAccountUsage, AccountUsage } from '../codex/usage.js';
import {
    clearConversation,
    findConversation,
    getConversation,
    listConversations,
    saveConversation,
    ConversationRecord
} from '../state/conversations.js';
import {
    findProject,
    getActiveProject,
    listProjects,
    saveProject,
    setActiveProject
} from '../state/projects.js';
import { addMcpServer, listMcpServers } from '../state/mcps.js';
import {
    getBridgeSettings,
    getEffectiveNotifyPermissionRequired,
    getEffectiveNotifyPromptFinished,
    getEffectiveNotifyUsageLimit,
    getEffectiveFinalResponsesAsImages,
    getEffectiveAutoSwitchOnLimit,
    getEffectiveModel,
    getEffectivePermissionMode,
    getEffectiveProvider,
    getEffectiveProviderPriority,
    getEffectiveReasoning,
    getEffectiveSlashResponsesEphemeral,
    getEffectiveAgentNames,
    isPermissionMode,
    isAgentNamingMode,
    isProviderType,
    isReasoningEffort,
    DEFAULT_MODEL_CHOICE,
    listModelChoices,
    updateBridgeSettings,
    PermissionMode,
    ProviderType,
    ReasoningEffort,
    AgentNamingMode
} from '../state/settings.js';
import { listAvailableModels, ModelChoiceMetadata } from '../models/catalog.js';
import { listRunningRuns, saveRun, updateRun, RunRecord } from '../state/runs.js';
import { getTokenStats, recordTokenUsage } from '../state/tokenStats.js';
import { getTranscript } from '../state/transcript.js';
import { recordUsageLimit } from '../state/usage.js';
import {
    checkForUpdate,
    formatUpdateNotice,
    markUpdateNotified,
    shouldNotifyUpdate
} from '../update/checker.js';
import { renderChatCard } from './chatCard.js';
import { collectDiscordContext, collectTargetChannelContext, withDiscordContext } from './context.js';
import { FileExplorerEntry, renderFileExplorerCard } from './fileExplorerCard.js';
import { renderFinalResponseCards } from './finalResponseCard.js';
import { createInitPrompt } from './initPrompt.js';
import { renderMcpCard } from './mcpCard.js';
import { AgentStatus, renderAccessRequestCard, renderLimitCard, renderThinkingGif, renderUsageStatsCard } from './statusCard.js';
import { renderSettingsCard, SettingsPage } from './settingsCard.js';
import { renderTerminalCard } from './terminalCard.js';
import { runTerminalCommand } from './terminal.js';
import { sanitizeDiscordText, splitDiscordText } from './text.js';
import { parseToolTags, withToolTagGuidance } from './toolTags.js';
import { renderUsageCard, renderUsageOverviewCard, UsageCardData, UsageCardWindow, UsageOverviewData } from './usageCard.js';
import { renderWorkspaceCard, WorkspaceCardGit } from './workspaceCard.js';

type ResponseTarget = Message | ChatInputCommandInteraction;
type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;
type UsageDashboardView = { components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]; files: AttachmentBuilder[] };
type UsageDashboardSession = { id: string; createdAt: number; accounts: AccountSummary[]; pages: Buffer[] };
type ModelPickerSession = { id: string; createdAt: number; provider: ProviderType; pages: ModelChoiceMetadata[][] };
type PromptOptions = {
    fresh?: boolean;
    workspace?: string;
    model?: string;
    dangerous?: boolean;
    provider?: ProviderType;
    permissionMode?: PermissionMode;
    reasoningEffort?: string | null;
    chatName?: string;
    discordThreadId?: string | null;
    codexThreadId?: string | null;
    runId?: string;
    recovering?: boolean;
    requesterId?: string;
};
type LimitRetry =
    | { kind: 'prompt'; conversationKey: string; prompt: string; options: PromptOptions; requesterId?: string }
    | { kind: 'review'; options: CodexReviewOptions; requesterId?: string };
type PendingProviderInstall = {
    retry: LimitRetry;
    command: string;
    executable: string;
    label: string;
    expiresAt: number;
};
type PendingSteer = { conversationKey: string; prompt: string; options: PromptOptions };
type QueuedSteer = PendingSteer & { noticeChannelId: string };
type PendingAccess = { target: ResponseTarget; conversationKey: string; prompt: string; options: PromptOptions };
type PendingLimit = { retry: LimitRetry; expiresAt: number };
type DashboardView = { components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]; files: AttachmentBuilder[] };
type ResponseCardSession = {
    id: string;
    createdAt: number;
    cards: Buffer[];
    extraFiles: AttachmentBuilder[];
    controls: ActionRowBuilder<ButtonBuilder>[];
};
type FileExplorerSessionEntry = FileExplorerEntry & { fullPath: string };
type FileExplorerSession = {
    id: string;
    root: string;
    cwd: string;
    createdAt: number;
    entries: FileExplorerSessionEntry[];
};
type FileExplorerFocus = { root: string; cwd: string; updatedAt: number };

const execFileAsync = promisify(execFile);
const activeRuns = new Set<string>();
const activeRunControllers = new Map<string, AbortController>();
const interruptedRuns = new Set<string>();
const usageDashboardSessions = new Map<string, UsageDashboardSession>();
const modelPickerSessions = new Map<string, ModelPickerSession>();
const pendingSteers = new Map<string, PendingSteer>();
const queuedSteers = new Map<string, QueuedSteer[]>();
const pendingAccessRequests = new Map<string, PendingAccess>();
const pendingLimitRetries = new Map<string, PendingLimit>();
const pendingProviderInstalls = new Map<string, PendingProviderInstall>();
const responseCardSessions = new Map<string, ResponseCardSession>();
const fileExplorerSessions = new Map<string, FileExplorerSession>();
const fileExplorerFocusByChannel = new Map<string, FileExplorerFocus>();
const componentMessageActivity = new Map<string, number>();
const componentMessages = new Map<string, Message>();
const latestComponentMessageByChannel = new Map<string, string>();
const ATTACHMENT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.log', '.json', '.md']);
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const MODEL_BUTTON_ID = 'discode:model-panel';
const REASONING_BUTTON_ID = 'discode:reasoning-panel';
const MODEL_SELECT_ID = 'discode:set-model';
const REASONING_SELECT_ID = 'discode:set-reasoning';
const PROVIDER_SELECT_ID = 'discode:set-provider';
const PROVIDER_PRIORITY_SELECT_ID = 'discode:set-provider-priority';
const PERMISSION_SELECT_ID = 'discode:set-permission';
const NOTIFY_DONE_SELECT_ID = 'discode:set-notify-done';
const NOTIFY_PERMISSION_SELECT_ID = 'discode:set-notify-permission';
const NOTIFY_LIMIT_SELECT_ID = 'discode:set-notify-limit';
const SLASH_PRIVACY_SELECT_ID = 'discode:set-slash-privacy';
const ACCESS_USERS_BUTTON_ID = 'discode:settings-access-users';
const ACCESS_USERS_MODAL_ID = 'discode:settings-access-users-modal';
const SETTINGS_PAGE_SELECT_ID = 'discode:settings-page';
const SETTINGS_BUTTON_ID = 'discode:settings-panel';
const TOKEN_STATS_BUTTON_ID = 'discode:token-stats';
const FINAL_RESPONSE_SELECT_ID = 'discode:set-final-response';
const FAILOVER_SELECT_ID = 'discode:set-failover';
const AGENT_NAMING_SELECT_ID = 'discode:set-agent-naming';
const AGENT_NAMES_BUTTON_ID = 'discode:agent-names';
const AGENT_NAMES_MODAL_ID = 'discode:agent-names-modal';
const ADD_ACCOUNT_BUTTON_ID = 'discode:add-account';
const ADD_ACCOUNT_PROVIDER_SELECT_ID = 'discode:add-account-provider';
const ADD_ACCOUNT_MODAL_ID = 'discode:add-account-modal';
const MODEL_PICKER_PREV_ID = 'discode:model-prev';
const MODEL_PICKER_NEXT_ID = 'discode:model-next';
const ACCESS_APPROVE_ID = 'discode:approve-access';
const CONVERSATION_SELECT_ID = 'discode:load-conversation';
const CHAT_LINK_SELECT_ID = 'discode:chat-link';
const ACCOUNT_SELECT_ID = 'discode:switch-account';
const LIMIT_ACCOUNT_SELECT_ID = 'discode:limit-switch-account';
const LIMIT_PROVIDER_SELECT_ID = 'discode:limit-switch-provider';
const INSTALL_PROVIDER_BUTTON_ID = 'discode:install-provider';
const QUEUE_PROMPT_BUTTON_ID = 'discode:queue-prompt';
const STEER_BUTTON_ID = 'discode:steer';
const USAGE_PREV_ID = 'discode:usage-prev';
const USAGE_NEXT_ID = 'discode:usage-next';
const USAGE_ACTIVATE_ACCOUNT_ID = 'discode:usage-activate-account';
const WORKSPACE_SELECT_ID = 'discode:set-workspace';
const WORKSPACE_ADD_BUTTON_ID = 'discode:add-workspace';
const WORKSPACE_ADD_MODAL_ID = 'discode:add-workspace-modal';
const FILE_EXPLORER_BUTTON_ID = 'discode:file-explorer';
const FILE_EXPLORER_SELECT_ID = 'discode:file-select';
const FILE_EXPLORER_UP_ID = 'discode:file-up';
const FILE_EXPLORER_ZIP_ID = 'discode:file-zip';
const FILE_EXPLORER_UPLOAD_ID = 'discode:file-upload';
const FILE_UPLOAD_MODAL_ID = 'discode:file-upload-modal';
const TERMINAL_RUN_BUTTON_ID = 'discode:terminal-run';
const TERMINAL_RUN_MODAL_ID = 'discode:terminal-run-modal';
const MCP_ADD_BUTTON_ID = 'discode:add-mcp';
const MCP_ADD_MODAL_ID = 'discode:add-mcp-modal';
const RESPONSE_CARD_PREV_ID = 'discode:response-prev';
const RESPONSE_CARD_NEXT_ID = 'discode:response-next';
const COMPONENT_IDLE_TTL_MS = 60 * 1000;
const USAGE_DASHBOARD_TTL_MS = COMPONENT_IDLE_TTL_MS;
const ACCOUNT_ADJECTIVES = ['North', 'Bright', 'Clear', 'Prime', 'Stone', 'Swift', 'True', 'Silver', 'Golden', 'Blue', 'Red', 'Green', 'Quiet', 'Open', 'Steady', 'Fresh'];
const ACCOUNT_NOUNS = ['Harbor', 'Keystone', 'Beacon', 'Ledger', 'Vault', 'Signal', 'Bridge', 'Forge', 'Anchor', 'Summit', 'Field', 'Orbit', 'Relay', 'Crown', 'Path', 'Gate'];
const AGENT_COLORS = ['#8b5cf6', '#10a37f', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6'];
const reasoningChoices: { label: string; value: ReasoningEffort; description: string }[] = [
    { label: 'None', value: 'none', description: 'Use the provider config default.' },
    { label: 'Low', value: 'low', description: 'Faster answers for lighter work.' },
    { label: 'Medium', value: 'medium', description: 'Balanced reasoning for normal work.' },
    { label: 'High', value: 'high', description: 'Deeper reasoning for harder tasks.' },
    { label: 'XHigh', value: 'xhigh', description: 'Maximum reasoning for complex work.' }
];
const providerChoices: { label: string; value: ProviderType; description: string }[] = [
    { label: 'Codex', value: 'codex', description: 'Use the local Codex CLI.' },
    { label: 'OpenCode', value: 'opencode', description: 'Use an opencode CLI wrapper.' },
    { label: 'Anthropic', value: 'anthropic', description: 'Use an Anthropic-compatible CLI.' },
    { label: 'Z.ai', value: 'zai', description: 'Use a Z.ai-compatible CLI.' },
    { label: 'Qwen', value: 'qwen', description: 'Use a Qwen-compatible CLI.' },
    { label: 'Custom', value: 'custom', description: 'Use DISCODE_PROVIDER_COMMAND.' }
];
const permissionChoices: { label: string; value: PermissionMode; description: string }[] = [
    { label: 'Full Access', value: 'full', description: 'Allow full agent automation.' },
    { label: 'Directory Only', value: 'directory', description: 'Ask before elevated access.' },
    { label: 'Auto-Review', value: 'auto-review', description: 'Run read-only by default.' }
];
const settingsPages: SettingsPage[] = ['runtime', 'access', 'notifications', 'display', 'failover'];
const idleProgressLabels = [
    'Thinking through the next step',
    'Checking the shape of the task',
    'Keeping the context focused',
    'Planning the next tool call',
    'Waiting on the model'
];

export class DiscordCodexBridge {
    private botName = 'Discode';
    private commandName = 'discode';

    constructor(
        private readonly config: BridgeConfig,
        private readonly runner: CodexRunner,
        private readonly accounts: AccountRouter
    ) {}

    setBotIdentity(botName: string, commandName: string): void {
        this.botName = this.cleanBotName(botName);
        this.commandName = this.cleanCommandName(commandName);
    }

    async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
        if (interaction.commandName !== this.commandName && interaction.commandName !== 'init') return;
        if (!(await this.isAuthorized(interaction.user.id))) {
            await interaction.respond([]);
            return;
        }

        const focused = interaction.options.getFocused(true);

        if (focused.name === 'account') {
            const accounts = await this.accounts.listAccounts();
            await interaction.respond(this.filterChoices(focused.value, accounts.map(account => ({
                name: this.getAccountAlias(account),
                value: String(account.index)
            }))));
            return;
        }

        if (focused.name === 'project' || focused.name === 'workspace') {
            const { projects } = await listProjects();
            await interaction.respond(this.filterChoices(focused.value, projects.map((project, index) => ({
                name: `${index + 1}. ${project.name} - ${project.workspace}`,
                value: focused.name === 'workspace' ? project.workspace : project.name
            }))));
            return;
        }

        if (focused.name === 'chat') {
            const chats = await listConversations();
            await interaction.respond(this.filterChoices(focused.value, chats.map((chat, index) => ({
                name: `${index + 1}. ${this.getConversationName(chat)} - ${path.basename(chat.workspace)}`,
                value: chat.name || chat.codexThreadId
            }))));
            return;
        }

        await interaction.respond([]);
    }

    async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!(await this.isAuthorized(interaction.user.id))) {
            await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (interaction.commandName === 'init') {
            await this.notifyUpdateIfNeeded(interaction);
            await this.handleInitInteraction(interaction);
            return;
        }

        if (interaction.commandName !== this.commandName) return;
        await this.notifyUpdateIfNeeded(interaction);

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'project' || subcommand === 'workspace') {
            await this.showWorkspaceDashboard(interaction);
            return;
        }

        if (subcommand === 'files') {
            await this.showFileExplorer(interaction, interaction.options.getString('workspace') || undefined);
            return;
        }

        if (subcommand === 'init') {
            await this.handleInitInteraction(interaction);
            return;
        }

        if (subcommand === 'chats') {
            await this.showChatsDashboard(interaction);
            return;
        }

        if (subcommand === 'conversations') {
            await this.showConversationPicker(interaction);
            return;
        }

        if (subcommand === 'load') {
            const chat = await findConversation(interaction.options.getString('chat', true));

            if (!chat) {
                await interaction.reply({ content: 'No saved chat matched that value.', ...(await this.getSlashReplyOptions()) });
                return;
            }
            await saveConversation({
                ...chat,
                discordChannelId: interaction.channelId,
                discordThreadId: interaction.channel?.isThread() ? interaction.channelId : chat.discordThreadId,
                updatedAt: new Date().toISOString()
            });
            await interaction.reply({ content: await this.renderLoadedChat(chat, interaction.guildId || undefined), ...(await this.getSlashReplyOptions()) });
            return;
        }

        if (subcommand === 'reset') {
            await clearConversation(interaction.channelId);
            await interaction.reply(`Cleared the ${this.botName} conversation for this channel.`);
            return;
        }

        if (subcommand === 'archive') {
            await this.archiveCurrentThread(interaction);
            return;
        }

        if (subcommand === 'prompt' || subcommand === 'new') {
            const prompt = subcommand === 'prompt'
                ? interaction.options.getString('prompt', true)
                : interaction.options.getString('prompt') || `Start a fresh ${this.botName} conversation and acknowledge readiness.`;
            const tools = parseToolTags(prompt, interaction.options.getString('tools'));
            const project = await this.resolveProject(interaction.options.getString('workspace') || undefined, interaction.options.getString('model') || undefined);
            const settings = await getBridgeSettings();
            const selectedModel = interaction.options.getString('model') || project.model || settings.model || undefined;
            const reasoningEffort = getEffectiveReasoning(settings);
            const provider = getEffectiveProvider(settings, this.config.defaultProvider);
            const permissionMode = getEffectivePermissionMode(settings, this.config.defaultPermissionMode);
            const shouldCreateThread = Boolean(interaction.guild && interaction.channel && !interaction.channel.isThread());
            const chatName = this.getChatName(prompt);

            if (shouldCreateThread) {
                await interaction.deferReply(await this.getSlashReplyOptions());
                const thread = await this.createThread(interaction.channel as TextChannel, chatName);
                await interaction.editReply(`Opened ${thread.url}`);
                const statusMessage = await this.sendThinkingMessage(thread, `Starting ${chatName}`);
                const discordContext = await collectDiscordContext(interaction, interaction.client, prompt);
                const codexPrompt = this.withPromptGuidance(withDiscordContext(prompt, discordContext), tools);
                await this.runPrompt(statusMessage, thread.id, codexPrompt, {
                    fresh: true,
                    workspace: project.workspace,
                    model: selectedModel,
                    provider,
                    permissionMode,
                    reasoningEffort,
                    dangerous: interaction.options.getBoolean('dangerous') === true || this.isPublishRequest(prompt),
                    chatName,
                    discordThreadId: thread.id,
                    requesterId: interaction.user.id
                });
                return;
            }

            await interaction.deferReply(await this.getSlashReplyOptions());
            const discordContext = await collectDiscordContext(interaction, interaction.client, prompt);
            const codexPrompt = this.withPromptGuidance(withDiscordContext(prompt, discordContext), tools);
            await this.runPrompt(interaction, interaction.channelId, codexPrompt, {
                fresh: subcommand === 'new' || interaction.options.getBoolean('new') === true,
                workspace: project.workspace,
                model: selectedModel,
                provider,
                permissionMode,
                reasoningEffort,
                dangerous: interaction.options.getBoolean('dangerous') === true || this.isPublishRequest(prompt),
                chatName,
                requesterId: interaction.user.id
            });
            return;
        }

        if (subcommand === 'image') {
            await interaction.deferReply(await this.getSlashReplyOptions());
            const prompt = interaction.options.getString('prompt', true);
            const image = interaction.options.getAttachment('image');
            const project = await this.resolveProject(interaction.options.getString('workspace') || undefined, interaction.options.getString('model') || undefined);
            const settings = await getBridgeSettings();
            const selectedModel = interaction.options.getString('model') || project.model || settings.model || undefined;
            const request = [
                prompt,
                image?.url ? `Source image: ${image.url}` : ''
            ].filter(Boolean).join('\n');

            await this.runPrompt(interaction, interaction.channelId, this.withPromptGuidance(request), {
                fresh: false,
                workspace: project.workspace,
                model: selectedModel,
                provider: getEffectiveProvider(settings, this.config.defaultProvider),
                permissionMode: getEffectivePermissionMode(settings, this.config.defaultPermissionMode),
                reasoningEffort: getEffectiveReasoning(settings),
                chatName: this.getChatName(`Image ${prompt}`),
                requesterId: interaction.user.id
            });
            return;
        }

        if (subcommand === 'review') {
            await interaction.deferReply(await this.getSlashReplyOptions());
            const project = await this.resolveProject(interaction.options.getString('workspace') || undefined, interaction.options.getString('model') || undefined);
            const settings = await getBridgeSettings();
            const selectedModel = interaction.options.getString('model') || project.model || settings.model || undefined;
            const permissionMode = getEffectivePermissionMode(settings, this.config.defaultPermissionMode);
            const scope = interaction.options.getString('scope', true) as 'uncommitted' | 'base' | 'commit';
            const instructions = interaction.options.getString('instructions') || '';
            const tools = parseToolTags(instructions, interaction.options.getString('tools'));
            const discordContext = await collectDiscordContext(interaction, interaction.client, instructions);
            await this.runReview(interaction, {
                scope,
                ref: interaction.options.getString('ref'),
                instructions: this.withPromptGuidance(withDiscordContext(instructions || 'Review the requested diff.', discordContext), tools),
                workspace: project.workspace,
                model: selectedModel,
                permissionMode: permissionMode === 'auto-review' ? 'auto-review' : undefined,
                reasoningEffort: getEffectiveReasoning(settings),
                dangerous: interaction.options.getBoolean('dangerous') === true,
                requesterId: interaction.user.id
            });
            return;
        }

        if (subcommand === 'triage') {
            const targetChannel = interaction.options.getChannel('channel', true) as any;
            const limit = interaction.options.getInteger('limit') || 25;
            const focus = interaction.options.getString('focus') || '';
            const tools = parseToolTags(focus, interaction.options.getString('tools'));
            const project = await this.resolveProject(interaction.options.getString('workspace') || undefined, interaction.options.getString('model') || undefined);
            const settings = await getBridgeSettings();
            const selectedModel = interaction.options.getString('model') || project.model || settings.model || undefined;
            const reasoningEffort = getEffectiveReasoning(settings);
            const provider = getEffectiveProvider(settings, this.config.defaultProvider);
            const permissionMode = getEffectivePermissionMode(settings, this.config.defaultPermissionMode);
            const chatName = this.getChatName(`Triage ${targetChannel.name || targetChannel.id}`);
            const shouldCreateThread = Boolean(interaction.guild && interaction.channel && !interaction.channel.isThread());

            if (shouldCreateThread) {
                await interaction.deferReply(await this.getSlashReplyOptions());
                const thread = await this.createThread(interaction.channel as TextChannel, chatName);
                await interaction.editReply(`Opened ${thread.url}`);
                const statusMessage = await this.sendThinkingMessage(thread, `Starting ${chatName}`);
                const codexPrompt = this.withPromptGuidance(await this.createTriagePrompt(interaction.client, targetChannel.id, limit, focus), tools);
                await this.runPrompt(statusMessage, thread.id, codexPrompt, {
                    fresh: true,
                    workspace: project.workspace,
                    model: selectedModel,
                    provider,
                    permissionMode,
                    reasoningEffort,
                    dangerous: interaction.options.getBoolean('dangerous') === true,
                    chatName,
                    discordThreadId: thread.id,
                    requesterId: interaction.user.id
                });
                return;
            }

            await interaction.deferReply(await this.getSlashReplyOptions());
            const codexPrompt = this.withPromptGuidance(await this.createTriagePrompt(interaction.client, targetChannel.id, limit, focus), tools);
            await this.runPrompt(interaction, interaction.channelId, codexPrompt, {
                workspace: project.workspace,
                model: selectedModel,
                provider,
                permissionMode,
                reasoningEffort,
                dangerous: interaction.options.getBoolean('dangerous') === true,
                chatName,
                requesterId: interaction.user.id
            });
            return;
        }

        if (subcommand === 'usage') {
            await this.showUsageDashboard(interaction);
            return;
        }

        if (subcommand === 'stats') {
            await this.showTokenStats(interaction, interaction.channelId);
            return;
        }

        if (subcommand === 'settings') {
            await this.showSettingsDashboard(interaction);
            return;
        }

        if (subcommand === 'terminal') {
            await this.showTerminalDashboard(interaction);
            return;
        }

        if (subcommand === 'mcp') {
            await this.showMcpDashboard(interaction);
            return;
        }

    }

    private async handleInitInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
        const project = await this.resolveProject(
            interaction.options.getString('workspace') || undefined,
            interaction.options.getString('model') || undefined
        );
        const settings = await getBridgeSettings();
        const selectedModel = interaction.options.getString('model') || project.model || settings.model || undefined;
        const reasoningEffort = getEffectiveReasoning(settings);
        const provider = getEffectiveProvider(settings, this.config.defaultProvider);
        const permissionMode = getEffectivePermissionMode(settings, this.config.defaultPermissionMode);
        const tools = parseToolTags(interaction.options.getString('tools'));
        const prompt = this.withPromptGuidance(createInitPrompt(project.workspace), tools);
        const chatName = 'Initialize workspace';
        const shouldCreateThread = Boolean(interaction.guild && interaction.channel && !interaction.channel.isThread());

        if (shouldCreateThread) {
            await interaction.deferReply(await this.getSlashReplyOptions());
            const thread = await this.createThread(interaction.channel as TextChannel, chatName);
            await interaction.editReply(`Opened ${thread.url}`);
            const statusMessage = await this.sendThinkingMessage(thread, `Starting ${chatName}`);
            await this.runPrompt(statusMessage, thread.id, prompt, {
                fresh: true,
                workspace: project.workspace,
                model: selectedModel,
                provider,
                permissionMode,
                reasoningEffort,
                dangerous: interaction.options.getBoolean('dangerous') === true,
                chatName,
                discordThreadId: thread.id,
                requesterId: interaction.user.id
            });
            return;
        }

        await interaction.deferReply(await this.getSlashReplyOptions());
        await this.runPrompt(interaction, interaction.channelId, prompt, {
            fresh: true,
            workspace: project.workspace,
            model: selectedModel,
            provider,
            permissionMode,
            reasoningEffort,
            dangerous: interaction.options.getBoolean('dangerous') === true,
            chatName,
            requesterId: interaction.user.id
        });
    }

    async handleComponent(interaction: ComponentInteraction): Promise<void> {
        if (!(await this.isAuthorized(interaction.user.id))) {
            await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (await this.expireInactiveComponent(interaction)) return;

        if (interaction.isButton() && interaction.customId === MODEL_BUTTON_ID) {
            await this.showModelPicker(interaction);
            return;
        }

        if (interaction.isButton() && interaction.customId === REASONING_BUTTON_ID) {
            await this.showReasoningPicker(interaction);
            return;
        }

        if (interaction.isButton() && interaction.customId === TOKEN_STATS_BUTTON_ID) {
            await this.showTokenStats(interaction, interaction.channelId);
            return;
        }

        if (interaction.isButton() && interaction.customId === SETTINGS_BUTTON_ID) {
            await this.showSettingsDashboard(interaction, 'runtime');
            return;
        }

        if (interaction.isButton() && interaction.customId === AGENT_NAMES_BUTTON_ID) {
            await interaction.showModal(await this.createAgentNamesModal());
            return;
        }

        if (interaction.isButton() && interaction.customId === ADD_ACCOUNT_BUTTON_ID) {
            await this.showAddAccountProviderPicker(interaction);
            return;
        }

        if (interaction.isButton() && (interaction.customId.startsWith(MODEL_PICKER_PREV_ID) || interaction.customId.startsWith(MODEL_PICKER_NEXT_ID))) {
            await interaction.deferUpdate();
            const parts = interaction.customId.split(':');
            const page = Math.max(0, Number(parts.at(-1)) || 0);
            const sessionId = parts.at(-2) || '';

            await interaction.editReply(this.createModelPickerPayload(sessionId, page));
            return;
        }

        if (interaction.isButton() && interaction.customId === ACCESS_USERS_BUTTON_ID) {
            await interaction.showModal(await this.createAccessUsersModal());
            return;
        }

        if (interaction.isButton() && interaction.customId === WORKSPACE_ADD_BUTTON_ID) {
            await interaction.showModal(this.createWorkspaceModal());
            return;
        }

        if (interaction.isButton() && interaction.customId === FILE_EXPLORER_BUTTON_ID) {
            await this.showFileExplorer(interaction);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith(FILE_EXPLORER_UP_ID)) {
            await interaction.deferUpdate();
            const sessionId = interaction.customId.split(':').at(-1) || '';

            await this.moveFileExplorerUp(interaction, sessionId);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith(FILE_EXPLORER_ZIP_ID)) {
            await interaction.deferUpdate();
            const sessionId = interaction.customId.split(':').at(-1) || '';

            await this.sendDirectoryZip(interaction, sessionId);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith(FILE_EXPLORER_UPLOAD_ID)) {
            const sessionId = interaction.customId.split(':').at(-1) || '';

            await interaction.showModal(this.createFileUploadModal(sessionId));
            return;
        }

        if (interaction.isButton() && interaction.customId === TERMINAL_RUN_BUTTON_ID) {
            await interaction.showModal(this.createTerminalModal());
            return;
        }

        if (interaction.isButton() && interaction.customId === MCP_ADD_BUTTON_ID) {
            await interaction.showModal(this.createMcpModal());
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith(ACCESS_APPROVE_ID)) {
            const id = interaction.customId.split(':').at(-1) || '';
            const pending = pendingAccessRequests.get(id);

            if (!pending) {
                await interaction.reply({ content: 'That access request expired.', flags: MessageFlags.Ephemeral });
                return;
            }
            pendingAccessRequests.delete(id);
            await interaction.update({ content: 'Access approved for this run.', components: [] });
            await this.runPrompt(pending.target, pending.conversationKey, pending.prompt, {
                ...pending.options,
                permissionMode: 'full',
                dangerous: true
            });
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith(INSTALL_PROVIDER_BUTTON_ID)) {
            const id = interaction.customId.split(':').at(-1) || '';

            await this.installProviderAndRetry(interaction, id);
            return;
        }

        if (interaction.isButton() && (
            interaction.customId.startsWith(QUEUE_PROMPT_BUTTON_ID)
            || interaction.customId.startsWith(STEER_BUTTON_ID)
        )) {
            const id = interaction.customId.split(':').at(-1) || '';
            const pending = pendingSteers.get(id);

            if (!pending) {
                await interaction.reply({ content: 'That steer prompt expired.', flags: MessageFlags.Ephemeral });
                return;
            }
            pendingSteers.delete(id);
            const shouldInterrupt = interaction.customId.startsWith(STEER_BUTTON_ID);

            this.enqueuePrompt(pending, interaction.channelId, shouldInterrupt);
            if (shouldInterrupt) {
                activeRunControllers.get(pending.conversationKey)?.abort();
            }
            await interaction.update({
                content: shouldInterrupt
                    ? 'Interrupting the active run and steering with this prompt.'
                    : 'Queued this prompt after the current run.',
                components: []
            });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === PROVIDER_SELECT_ID) {
            const selected = interaction.values[0];

            if (isProviderType(selected)) {
                await updateBridgeSettings({ provider: selected });
            }
            await this.updateSettingsDashboard(interaction, 'runtime');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === PROVIDER_PRIORITY_SELECT_ID) {
            const values = interaction.values.filter(isProviderType);

            await updateBridgeSettings({ providerPriority: values });
            await this.updateSettingsDashboard(interaction, 'failover');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === PERMISSION_SELECT_ID) {
            const selected = interaction.values[0];

            if (isPermissionMode(selected)) {
                await updateBridgeSettings({ permissionMode: selected });
            }
            await this.updateSettingsDashboard(interaction, 'access');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === NOTIFY_DONE_SELECT_ID) {
            await updateBridgeSettings({
                notifyPromptFinished: interaction.values[0] === 'on',
                reminderPings: interaction.values[0] === 'on'
            });
            await this.updateSettingsDashboard(interaction, 'notifications');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === NOTIFY_PERMISSION_SELECT_ID) {
            await updateBridgeSettings({ notifyPermissionRequired: interaction.values[0] === 'on' });
            await this.updateSettingsDashboard(interaction, 'notifications');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === NOTIFY_LIMIT_SELECT_ID) {
            await updateBridgeSettings({ notifyUsageLimit: interaction.values[0] === 'on' });
            await this.updateSettingsDashboard(interaction, 'notifications');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === SLASH_PRIVACY_SELECT_ID) {
            await updateBridgeSettings({ slashResponsesEphemeral: interaction.values[0] === 'ephemeral' });
            await this.updateSettingsDashboard(interaction, 'display');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === FINAL_RESPONSE_SELECT_ID) {
            await updateBridgeSettings({ finalResponsesAsImages: interaction.values[0] === 'images' });
            await this.updateSettingsDashboard(interaction, 'display');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === AGENT_NAMING_SELECT_ID) {
            const selected = interaction.values[0];

            if (isAgentNamingMode(selected)) {
                await updateBridgeSettings({ agentNamingMode: selected });
            }
            await this.updateSettingsDashboard(interaction, 'display');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === FAILOVER_SELECT_ID) {
            await updateBridgeSettings({ autoSwitchOnLimit: interaction.values[0] === 'on' });
            await this.updateSettingsDashboard(interaction, 'failover');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === ADD_ACCOUNT_PROVIDER_SELECT_ID) {
            const provider = interaction.values[0];

            if (!isProviderType(provider)) {
                await interaction.reply({ content: 'That provider is not supported.', flags: MessageFlags.Ephemeral });
                return;
            }
            await interaction.showModal(this.createAddAccountModal(provider));
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith(FILE_EXPLORER_SELECT_ID)) {
            await interaction.deferUpdate();
            const sessionId = interaction.customId.split(':').at(-1) || '';

            await this.handleFileExplorerSelection(interaction, sessionId, interaction.values[0]);
            return;
        }

        if (interaction.isButton() && (interaction.customId.startsWith(RESPONSE_CARD_PREV_ID) || interaction.customId.startsWith(RESPONSE_CARD_NEXT_ID))) {
            await interaction.deferUpdate();
            const parts = interaction.customId.split(':');
            const page = Math.max(0, Number(parts.at(-1)) || 0);
            const sessionId = parts.at(-2) || '';
            const view = this.createResponseCardView(sessionId, page);

            if (!view) {
                await interaction.editReply({ content: 'That response page expired.', attachments: [], components: [] });
                return;
            }
            await interaction.editReply({
                content: '',
                embeds: [],
                attachments: [],
                components: view.components,
                files: view.files
            });
            this.scheduleComponentExpiry(interaction.message, view.components.length > 0, true);
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === SETTINGS_PAGE_SELECT_ID) {
            const selected = interaction.values[0] as SettingsPage;

            await this.updateSettingsDashboard(interaction, settingsPages.includes(selected) ? selected : 'runtime');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === WORKSPACE_SELECT_ID) {
            await interaction.deferUpdate();
            await setActiveProject(interaction.values[0]);
            const dashboard = await this.createWorkspaceDashboard();

            await interaction.editReply({
                content: '',
                embeds: [],
                attachments: [],
                components: dashboard.components,
                files: dashboard.files
            });
            this.scheduleComponentExpiry(interaction.message, dashboard.components.length > 0);
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === MODEL_SELECT_ID) {
            await updateBridgeSettings({ model: interaction.values[0] === DEFAULT_MODEL_CHOICE ? null : interaction.values[0] });
            await this.updateSettingsDashboard(interaction, 'runtime');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === REASONING_SELECT_ID) {
            const selected = interaction.values[0];

            if (isReasoningEffort(selected)) {
                await updateBridgeSettings({ reasoningEffort: selected });
            }
            await this.updateSettingsDashboard(interaction, 'runtime');
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === CONVERSATION_SELECT_ID) {
            const chat = await findConversation(interaction.values[0]);

            if (!chat) {
                await interaction.update({ content: 'That conversation no longer exists.', components: [] });
                return;
            }
            await saveConversation({
                ...chat,
                discordChannelId: interaction.channelId,
                discordGuildId: interaction.guildId || chat.discordGuildId || null,
                discordThreadId: interaction.channel?.isThread() ? interaction.channelId : chat.discordThreadId,
                updatedAt: new Date().toISOString()
            });
            await interaction.update({
                content: await this.renderLoadedChat(chat, interaction.guildId || undefined),
                components: []
            });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId === CHAT_LINK_SELECT_ID) {
            const chat = await findConversation(interaction.values[0]);

            if (!chat) {
                await interaction.reply({ content: 'That chat no longer exists.', flags: MessageFlags.Ephemeral });
                return;
            }
            await interaction.reply({
                content: this.createConversationLink(chat, interaction.guildId || undefined),
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith(ACCOUNT_SELECT_ID)) {
            await interaction.deferUpdate();
            const sessionId = interaction.customId.split(':').at(-1) || '';
            const page = Math.max(0, Number(interaction.values[0]));
            const dashboard = this.createUsageDashboardView(sessionId, page) || await this.createUsageDashboard(page);

            await interaction.editReply({
                content: '',
                embeds: [],
                attachments: [],
                components: dashboard.components,
                files: dashboard.files
            });
            this.scheduleComponentExpiry(interaction.message, dashboard.components.length > 0);
            return;
        }

        if (interaction.isButton() && interaction.customId.startsWith(USAGE_ACTIVATE_ACCOUNT_ID)) {
            await interaction.deferUpdate();
            const page = Math.max(1, Number(interaction.customId.split(':').at(-1)) || 1);
            const account = await this.accounts.switchTo(String(page));
            const dashboard = await this.createUsageDashboard(page);

            await interaction.editReply({
                content: `Using ${account.name}.`,
                embeds: [],
                attachments: [],
                components: dashboard.components,
                files: dashboard.files
            });
            this.scheduleComponentExpiry(interaction.message, dashboard.components.length > 0);
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith(LIMIT_ACCOUNT_SELECT_ID)) {
            await interaction.deferUpdate();
            const retryId = interaction.customId.split(':').at(-1) || '';
            const account = await this.accounts.switchTo(interaction.values[0]);
            const accounts = await this.accounts.listAccounts();
            const summary = accounts.find(item => item.id === account.id);

            await interaction.editReply({
                content: `Switched to ${summary ? this.getAccountAlias(summary) : 'selected account'} and retrying.`,
                components: []
            });
            await this.runPendingLimitRetry(interaction, retryId, { provider: summary?.provider });
            return;
        }

        if (interaction.isStringSelectMenu() && interaction.customId.startsWith(LIMIT_PROVIDER_SELECT_ID)) {
            await interaction.deferUpdate();
            const retryId = interaction.customId.split(':').at(-1) || '';
            const provider = interaction.values[0];

            if (!isProviderType(provider)) {
                await interaction.editReply({ content: 'That provider is no longer available.', components: [] });
                return;
            }
            await updateBridgeSettings({ provider });
            await interaction.editReply({
                content: `Switched to ${this.capitalize(provider)} and retrying.`,
                components: []
            });
            await this.runPendingLimitRetry(interaction, retryId, { provider });
            return;
        }

        if (interaction.isButton() && (interaction.customId.startsWith(USAGE_PREV_ID) || interaction.customId.startsWith(USAGE_NEXT_ID))) {
            await interaction.deferUpdate();
            const parts = interaction.customId.split(':');
            const page = Number(parts.at(-1)) || 0;
            const sessionId = parts.at(-2) || '';
            const dashboard = this.createUsageDashboardView(sessionId, page) || await this.createUsageDashboard(page);

            await interaction.editReply({
                content: '',
                embeds: [],
                attachments: [],
                components: dashboard.components,
                files: dashboard.files
            });
            this.scheduleComponentExpiry(interaction.message, dashboard.components.length > 0);
        }
    }

    async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
        if (!(await this.isAuthorized(interaction.user.id))) {
            await interaction.reply({ content: 'Access denied.', flags: MessageFlags.Ephemeral });
            return;
        }

        if (interaction.customId === WORKSPACE_ADD_MODAL_ID) {
            const workspace = this.expandHomePath(interaction.fields.getTextInputValue('workspace').trim());
            const name = this.cleanProjectName(interaction.fields.getTextInputValue('name') || path.basename(workspace));
            const model = interaction.fields.getTextInputValue('model').trim() || undefined;

            await mkdir(workspace, { recursive: true });
            await saveProject({ name, workspace, model });
            await this.showWorkspaceDashboard(interaction);
            return;
        }

        if (interaction.customId === TERMINAL_RUN_MODAL_ID) {
            const project = await this.resolveProject();
            const command = interaction.fields.getTextInputValue('command').trim();
            const timeout = Number(interaction.fields.getTextInputValue('timeout').trim()) || 120;
            const ephemeral = getEffectiveSlashResponsesEphemeral(await getBridgeSettings());

            await runTerminalCommand(interaction, command, project.workspace, Math.min(Math.max(timeout, 5), 900) * 1000, ephemeral);
            return;
        }

        if (interaction.customId === MCP_ADD_MODAL_ID) {
            const name = interaction.fields.getTextInputValue('name').trim();
            const command = interaction.fields.getTextInputValue('command').trim();
            const args = interaction.fields.getTextInputValue('args').trim();

            await addMcpServer(name, command, args);
            await this.showMcpDashboard(interaction);
            return;
        }

        if (interaction.customId === ACCESS_USERS_MODAL_ID) {
            const allowedUserIds = this.parseUserIds(interaction.fields.getTextInputValue('allowedUsers'));
            const primaryAllowedUserId = this.parseUserIds(interaction.fields.getTextInputValue('primaryUser'))[0] || allowedUserIds[0] || null;

            await updateBridgeSettings({ allowedUserIds, primaryAllowedUserId });
            await this.showSettingsDashboard(interaction, 'access');
            return;
        }

        if (interaction.customId === AGENT_NAMES_MODAL_ID) {
            const customAgentNames = interaction.fields.getTextInputValue('agentNames')
                .split(',')
                .map(value => value.trim())
                .filter(Boolean)
                .slice(0, 32);

            await updateBridgeSettings({
                agentNamingMode: customAgentNames.length > 0 ? 'custom' : 'greek',
                customAgentNames
            });
            await this.showSettingsDashboard(interaction, 'display');
            return;
        }

        if (interaction.customId.startsWith(`${FILE_UPLOAD_MODAL_ID}:`)) {
            const sessionId = interaction.customId.split(':').at(-1) || '';
            const source = interaction.fields.getTextInputValue('source').trim();
            const session = fileExplorerSessions.get(sessionId);

            if (!session || !source) {
                await interaction.reply({ content: 'That file explorer session expired.', flags: MessageFlags.Ephemeral });
                return;
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await this.importFileIntoDirectory(source, session.cwd);

            await interaction.editReply(result);
            await this.refreshFileExplorerMessage(interaction.message as Message | null, sessionId);
            return;
        }

        if (interaction.customId.startsWith(`${ADD_ACCOUNT_MODAL_ID}:`)) {
            const provider = interaction.customId.split(':').at(-1) || '';

            if (!isProviderType(provider)) {
                await interaction.reply({ content: 'That provider is not supported.', flags: MessageFlags.Ephemeral });
                return;
            }
            const name = interaction.fields.getTextInputValue('name').trim();
            const apiKey = interaction.fields.getTextInputValue('apiKey').trim();
            const email = interaction.fields.getTextInputValue('email').trim();
            const priority = Number(interaction.fields.getTextInputValue('priority').trim());
            const command = interaction.fields.getTextInputValue('command').trim();
            const account = await this.accounts.addAccount({
                name,
                provider,
                email,
                priority: Number.isFinite(priority) ? priority : undefined,
                command: command || undefined,
                auth_mode: apiKey ? 'api_key' : 'login',
                auth_data: apiKey ? {
                    api_key: apiKey,
                    env_key: this.defaultApiKeyName(provider)
                } : {
                    type: 'login'
                }
            }, true);

            await interaction.reply({
                content: `Added and activated ${account.name}.`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    async recoverRunningRuns(client: Client): Promise<void> {
        for (const run of await listRunningRuns()) {
            if (activeRuns.has(run.conversationKey)) continue;

            const channel = await client.channels.fetch(run.channelId).catch(() => null);

            if (!channel || !('send' in channel)) {
                await updateRun(run.id, { status: 'failed' });
                continue;
            }
            await this.cleanupRecoveredStatusMessage(channel as any, run.messageId);
            const statusMessage = await this.sendThinkingMessage(channel as any, 'Bot restarted, resuming this task');
            await this.runPrompt(statusMessage, run.conversationKey, run.prompt || 'Continue the previous task.', {
                fresh: false,
                workspace: run.workspace,
                model: run.model || undefined,
                provider: isProviderType(run.provider) ? run.provider : undefined,
                permissionMode: isPermissionMode(run.permissionMode) ? run.permissionMode : undefined,
                reasoningEffort: run.reasoningEffort,
                dangerous: run.dangerous,
                chatName: run.chatName,
                discordThreadId: run.discordThreadId,
                codexThreadId: run.codexThreadId,
                runId: run.id,
                recovering: true
            });
        }
    }

    private async cleanupRecoveredStatusMessage(channel: any, messageId?: string | null): Promise<void> {
        if (!messageId || !channel?.messages?.fetch) return;
        const message = await channel.messages.fetch(messageId).catch(() => null);

        if (!message) return;
        await message.delete().catch(async () => {
            await message.edit({
                content: '',
                embeds: [],
                attachments: [],
                components: []
            }).catch(() => undefined);
        });
    }

    async handleMessage(message: Message, client: Client): Promise<boolean> {
        if (message.author.bot) return false;

        const prompt = this.extractMentionPrompt(message, client);
        const isCodexThread = message.channel.isThread() && this.isAgentThreadName(message.channel.name);

        if (prompt === null && !isCodexThread) return false;

        if (!(await this.isAuthorized(message.author.id))) {
            if (prompt !== null) {
                await message.reply('Access denied.');
                return true;
            }

            return false;
        }

        await this.notifyUpdateIfNeeded(message);

        if (prompt === null && this.shouldIgnoreThreadMessage(message)) return false;

        const request = this.getMessageRequest(message, prompt);

        if (!request) {
            await message.reply('Send a prompt after the mention.');
            return true;
        }

        if (message.attachments.size > 0 && this.isFileUploadRequest(request)) {
            await this.saveUploadedAttachments(message, request);
            return true;
        }

        if (this.isDirectoryExplorerRequest(request)) {
            await this.sendFileExplorerMessage(message, request);
            return true;
        }

        const project = await this.resolveNaturalProject(request) || await this.resolveProject();
        const settings = await getBridgeSettings();
        const selectedModel = project.model || settings.model || undefined;
        const reasoningEffort = getEffectiveReasoning(settings);
        const provider = getEffectiveProvider(settings, this.config.defaultProvider);
        const permissionMode = getEffectivePermissionMode(settings, this.config.defaultPermissionMode);
        const naturalToolPrompt = await this.createNaturalToolPrompt(message, client, request);
        const shouldIncludeDiscordThreadContext = !isCodexThread
            || message.attachments.size > 0
            || Boolean(message.reference?.messageId)
            || this.hasContextReference(request);
        const codexPrompt = this.withPromptGuidance(
            naturalToolPrompt || withDiscordContext(request, await collectDiscordContext(message, client, request, {
                includeCurrentChannel: shouldIncludeDiscordThreadContext
            })),
            parseToolTags(request)
        );

        if (message.guild && !message.channel.isThread()) {
            const chatName = this.getChatName(request);
            const thread = await this.createThread(message.channel as TextChannel, chatName);
            const statusMessage = await this.sendThinkingMessage(thread, `Starting ${chatName}`);
            await this.runPrompt(statusMessage, thread.id, codexPrompt, {
                fresh: true,
                workspace: project.workspace,
                model: selectedModel,
                provider,
                permissionMode,
                reasoningEffort,
                dangerous: this.isPublishRequest(request),
                chatName,
                discordThreadId: thread.id,
                requesterId: message.author.id
            });
            return true;
        }

        const promptOptions: PromptOptions = {
            workspace: project.workspace,
            model: selectedModel,
            provider,
            permissionMode,
            reasoningEffort,
            dangerous: this.isPublishRequest(request),
            chatName: this.getChatName(request),
            discordThreadId: message.channel.isThread() ? message.channel.id : null,
            requesterId: message.author.id
        };

        if (activeRuns.has(message.channel.id)) {
            await this.sendSteerOffer(message, message.channel.id, codexPrompt, promptOptions);
            return true;
        }

        const statusMessage = await this.sendThinkingMessage(message.channel as any, `Starting ${this.botName}`);
        await this.runPrompt(statusMessage, message.channel.id, codexPrompt, promptOptions);

        return true;
    }

    private async runPrompt(target: ResponseTarget, conversationKey: string, prompt: string, options: PromptOptions): Promise<void> {
        if (activeRuns.has(conversationKey)) {
            await this.sendSteerOffer(target, conversationKey, prompt, options);
            return;
        }

        if (this.needsAccessApproval(prompt, options)) {
            await this.sendAccessRequest(target, conversationKey, prompt, options);
            return;
        }

        activeRuns.add(conversationKey);
        const controller = new AbortController();
        activeRunControllers.set(conversationKey, controller);
        const progress = this.createProgressUpdater(target, prompt);
        const runId = options.runId || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        try {
            progress.push(`Starting ${this.botName}`);
            if (options.fresh) {
                await clearConversation(conversationKey);
            }
            const conversation = options.fresh ? null : await getConversation(conversationKey);
            await saveRun({
                id: runId,
                type: 'prompt',
                status: 'running',
                targetType: target instanceof Message ? 'message' : 'interaction',
                channelId: target.channelId,
                messageId: target instanceof Message ? target.id : null,
                interactionToken: target instanceof Message ? null : target.token,
                applicationId: target instanceof Message ? null : target.applicationId,
                conversationKey,
                prompt,
                workspace: options.workspace || conversation?.workspace || this.config.defaultWorkspace,
                model: options.model || conversation?.model || null,
                provider: options.provider || null,
                permissionMode: options.permissionMode || null,
                reasoningEffort: options.reasoningEffort || null,
                dangerous: options.dangerous,
                fresh: options.recovering ? false : options.fresh,
                codexThreadId: options.codexThreadId || conversation?.codexThreadId || null,
                chatName: options.chatName,
                discordThreadId: options.discordThreadId ?? conversation?.discordThreadId ?? null,
                imagePaths: this.extractImagePaths(prompt),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            const result = await this.runner.runPrompt({
                prompt,
                workspace: options.workspace || conversation?.workspace,
                model: options.model || conversation?.model,
                provider: options.provider,
                permissionMode: options.permissionMode,
                reasoningEffort: options.reasoningEffort,
                dangerous: options.dangerous,
                fresh: options.recovering ? false : options.fresh,
                codexThreadId: options.codexThreadId || conversation?.codexThreadId,
                imagePaths: this.extractImagePaths(prompt),
                signal: controller.signal,
                onEvent: event => {
                    if (event.threadId) {
                        void updateRun(runId, { codexThreadId: event.threadId });
                    }
                    progress.push(event.label, event.text);
                }
            });

            let savedConversation: ConversationRecord | null = null;

            if (result.threadId) {
                savedConversation = {
                    discordChannelId: conversationKey,
                    discordGuildId: target.guildId || conversation?.discordGuildId || null,
                    discordThreadId: options.discordThreadId ?? conversation?.discordThreadId ?? null,
                    latestMessageId: conversation?.latestMessageId || null,
                    codexThreadId: result.threadId,
                    name: this.selectConversationName(conversation?.name, options.chatName, prompt),
                    workspace: options.workspace || conversation?.workspace || this.config.defaultWorkspace,
                    model: options.model || conversation?.model || null,
                    updatedAt: new Date().toISOString()
                };
                await saveConversation(savedConversation);
                await this.renameThreadIfUseful(target, savedConversation.name);
            }

            await progress.flush();
            if (result.limitError) {
                await recordUsageLimit({
                    accountId: result.limitAccountId || null,
                    accountName: result.limitAccountName || null,
                    message: result.limitError.slice(0, 2000),
                    resetAt: this.extractResetTime(result.limitError)
                });
            }
            if (result.usage) {
                await recordTokenUsage(conversationKey, result.usage).catch(error => console.warn('Failed to record token stats:', error));
            }
            if (!result.ok && this.isUsageLimitText(result.error || result.text)) {
                await this.recordCurrentUsageLimit(result.error || result.text);
            }
            await updateRun(runId, {
                status: result.ok ? 'completed' : 'failed',
                codexThreadId: result.threadId || options.codexThreadId || conversation?.codexThreadId || null
            });
            const resultText = !result.ok && this.isUsageLimitText(result.error || result.text)
                ? `Usage limit reached on the active account.\n\n${result.error || result.text}`
                : result.ok ? result.text : `${this.botName} failed.\n\n${result.error || result.text}`;
            if (interruptedRuns.has(conversationKey) && !result.ok) {
                await updateRun(runId, {
                    status: 'failed',
                    codexThreadId: result.threadId || options.codexThreadId || conversation?.codexThreadId || null
                });
                return;
            }
            if (!result.ok && this.isUsageLimitText(result.error || result.text)) {
                await this.sendLimitResponse(target, result.error || result.text, {
                    kind: 'prompt',
                    conversationKey,
                    prompt,
                    options: {
                        ...options,
                        fresh: false
                    },
                    requesterId: options.requesterId
                });
                return;
            }
            if (!result.ok && result.missingExecutable) {
                await this.sendMissingProviderResponse(target, result, {
                    kind: 'prompt',
                    conversationKey,
                    prompt,
                    options: {
                        ...options,
                        fresh: false
                    },
                    requesterId: options.requesterId
                });
                return;
            }
            const latestMessage = await this.sendPages(
                target,
                this.withFooter(resultText, result),
                result
            );
            await this.ghostPingIfEnabled(target, options.requesterId);
            if (savedConversation) {
                await saveConversation({
                    ...savedConversation,
                    latestMessageId: latestMessage?.id || savedConversation.latestMessageId || null,
                    updatedAt: new Date().toISOString()
                });
            }
        } finally {
            activeRuns.delete(conversationKey);
            if (activeRunControllers.get(conversationKey) === controller) {
                activeRunControllers.delete(conversationKey);
            }
            interruptedRuns.delete(conversationKey);
            await this.runQueuedSteer(target, conversationKey);
        }
    }

    private async sendThinkingMessage(channel: any, task: string): Promise<Message> {
        const file = new AttachmentBuilder(await renderThinkingGif(task, this.botName, await this.createAgentRoster(task)), { name: `${this.commandName}-thinking.gif` });

        return channel.send({
            content: '',
            embeds: [],
            files: [file]
        });
    }

    private async runReview(target: ResponseTarget, options: CodexReviewOptions): Promise<void> {
        const conversationKey = `review:${options.workspace || this.config.defaultWorkspace}`;

        if (activeRuns.has(conversationKey)) {
            await this.sendPages(target, 'A Codex review is already running for that workspace.');
            return;
        }

        activeRuns.add(conversationKey);
        const progress = this.createProgressUpdater(target, options.instructions || 'review');

        try {
            progress.push('Starting review');
            const result = await this.runner.runReview({
                ...options,
                onEvent: event => progress.push(event.label, event.text)
            });
            if (result.limitError) {
                await recordUsageLimit({
                    accountId: result.limitAccountId || null,
                    accountName: result.limitAccountName || null,
                    message: result.limitError.slice(0, 2000),
                    resetAt: this.extractResetTime(result.limitError)
                });
            }
            if (result.usage) {
                await recordTokenUsage(conversationKey, result.usage).catch(error => console.warn('Failed to record token stats:', error));
                await recordTokenUsage(target.channelId, result.usage).catch(error => console.warn('Failed to record token stats:', error));
            }
            if (!result.ok && this.isUsageLimitText(result.error || result.text)) {
                await this.recordCurrentUsageLimit(result.error || result.text);
            }
            await progress.flush();
            const resultText = !result.ok && this.isUsageLimitText(result.error || result.text)
                ? `Usage limit reached on the active account.\n\n${result.error || result.text}`
                : result.ok ? result.text : `${this.botName} review failed.\n\n${result.error || result.text}`;
            if (!result.ok && this.isUsageLimitText(result.error || result.text)) {
                await this.sendLimitResponse(target, result.error || result.text, {
                    kind: 'review',
                    options,
                    requesterId: options.requesterId
                });
                return;
            }
            if (!result.ok && result.missingExecutable) {
                await this.sendMissingProviderResponse(target, result, {
                    kind: 'review',
                    options,
                    requesterId: options.requesterId
                });
                return;
            }
            await this.sendPages(
                target,
                this.withFooter(resultText, result),
                result
            );
            await this.ghostPingIfEnabled(target, options.requesterId);
        } finally {
            activeRuns.delete(conversationKey);
        }
    }

    private async ghostPingIfEnabled(target: ResponseTarget, requesterId?: string): Promise<void> {
        const settings = await getBridgeSettings();

        if (!getEffectiveNotifyPromptFinished(settings, this.config.defaultReminderPings)) return;
        const channel = target.channel;

        if (!channel || !('send' in channel)) return;
        const message = await (channel as any).send(await this.getUserMention(requesterId)).catch(() => null);

        if (!message) return;
        setTimeout(() => {
            void message.delete().catch(() => undefined);
        }, 1200);
    }

    private async sendSteerOffer(target: ResponseTarget, conversationKey: string, prompt: string, options: PromptOptions): Promise<void> {
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        pendingSteers.set(id, { conversationKey, prompt, options: { ...options, fresh: false } });
        setTimeout(() => pendingSteers.delete(id), COMPONENT_IDLE_TTL_MS);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${STEER_BUTTON_ID}:${id}`)
                .setLabel('Steer now')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`${QUEUE_PROMPT_BUTTON_ID}:${id}`)
                .setLabel('Queue prompt')
                .setStyle(ButtonStyle.Secondary)
        );
        const content = `${this.botName} is already running. Steer now interrupts the active run; queue keeps this prompt next.`;

        if (target instanceof Message) {
            const message = await (target.channel as any).send({ content, components: [row] });
            this.scheduleComponentExpiry(message, true);
            return;
        }

        const message = await target.editReply({ content, components: [row] });
        this.scheduleComponentExpiry(message as Message, true);
    }

    private async sendAccessRequest(target: ResponseTarget, conversationKey: string, prompt: string, options: PromptOptions): Promise<void> {
        const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        pendingAccessRequests.set(id, { target, conversationKey, prompt, options });
        setTimeout(() => pendingAccessRequests.delete(id), COMPONENT_IDLE_TTL_MS);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${ACCESS_APPROVE_ID}:${id}`)
                .setLabel('Approve once')
                .setStyle(ButtonStyle.Primary)
        );
        const file = new AttachmentBuilder(await renderAccessRequestCard('This request needs access beyond the current directory policy.'), { name: 'discode-access.png' });
        const payload = {
            content: getEffectiveNotifyPermissionRequired(await getBridgeSettings()) ? await this.getUserMention(options.requesterId, target) : '',
            embeds: [],
            attachments: [],
            components: [row],
            files: [file]
        };

        if (target instanceof Message) {
            const message = await target.edit(payload).catch(async () => {
                return (target.channel as any).send(payload);
            });
            this.scheduleComponentExpiry((message || target) as Message, true);
            return;
        }

        const message = await target.editReply(payload);
        this.scheduleComponentExpiry(message as Message, true);
    }

    private needsAccessApproval(prompt: string, options: PromptOptions): boolean {
        if (options.permissionMode !== 'directory') return false;
        if (options.dangerous) return true;

        return /\b(full access|bypass|outside (?:the )?(?:workspace|directory)|root access|sudo|publish|deploy|production|push live)\b/i.test(prompt);
    }

    private enqueuePrompt(pending: PendingSteer, noticeChannelId: string, interrupt: boolean): void {
        const queue = queuedSteers.get(pending.conversationKey) || [];
        const entry = {
            ...pending,
            noticeChannelId
        };

        if (interrupt) {
            queue.unshift(entry);
            interruptedRuns.add(pending.conversationKey);
        } else {
            queue.push(entry);
        }
        queuedSteers.set(pending.conversationKey, queue);
    }

    private async runQueuedSteer(target: ResponseTarget, conversationKey: string): Promise<void> {
        const queue = queuedSteers.get(conversationKey);
        const next = queue?.shift();

        if (!next) return;
        if (queue && queue.length === 0) queuedSteers.delete(conversationKey);
        const channel = target.channel;

        if (!channel || !('send' in channel)) return;
        const statusMessage = await this.sendThinkingMessage(channel as any, 'Starting steer');
        await this.runPrompt(statusMessage, conversationKey, next.prompt, {
            ...next.options,
            fresh: false
        });
    }

    private async sendLimitResponse(target: ResponseTarget, message: string, retry: LimitRetry): Promise<Message | null> {
        const resetAt = this.extractResetTime(message);
        const image = await renderLimitCard(message, resetAt ? this.formatDate(resetAt) : '');
        const accounts = await this.accounts.listAccounts();
        const settings = await getBridgeSettings();
        const retryId = this.createUsageSessionId();
        const provider = retry.kind === 'prompt'
            ? retry.options.provider || getEffectiveProvider(settings, this.config.defaultProvider)
            : getEffectiveProvider(settings, this.config.defaultProvider);
        const providerOptions = retry.kind === 'prompt'
            ? getEffectiveProviderPriority(settings, this.config.defaultProviderPriority)
                .filter(item => item !== provider)
                .slice(0, 25)
            : [];
        const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

        pendingLimitRetries.set(retryId, {
            retry,
            expiresAt: Date.now() + COMPONENT_IDLE_TTL_MS
        });
        if (accounts.length > 0) {
            components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${LIMIT_ACCOUNT_SELECT_ID}:${retryId}`)
                    .setPlaceholder('Switch account and retry')
                    .addOptions(accounts.slice(0, 25).map(account => ({
                        label: this.getAccountAlias(account).slice(0, 100),
                        value: String(account.index),
                        description: `${this.capitalize(account.provider)} · ${account.credentialLabel}`.slice(0, 100)
                    })))
            ));
        }
        if (providerOptions.length > 0) {
            components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${LIMIT_PROVIDER_SELECT_ID}:${retryId}`)
                    .setPlaceholder('Switch provider and retry')
                    .addOptions(providerOptions.map(item => ({
                        label: this.capitalize(item).slice(0, 100),
                        value: item,
                        description: 'Use this fallback provider for the retry.'
                    })))
            ));
        }
        const payload = {
            content: getEffectiveNotifyUsageLimit(settings) ? await this.getUserMention(retry.requesterId, target) : '',
            embeds: [],
            attachments: [],
            components,
            files: [new AttachmentBuilder(image, { name: `${this.commandName}-limit.png` })]
        };

        if (target instanceof Message) {
            const message = await target.edit(payload).catch(async () => {
                return (target.channel as any).send(payload);
            });
            this.scheduleComponentExpiry(message as Message, components.length > 0);
            return message as Message;
        }

        const messageResult = await target.editReply(payload);
        this.scheduleComponentExpiry(messageResult as Message, components.length > 0);

        return messageResult as Message;
    }

    private async sendMissingProviderResponse(target: ResponseTarget, result: CodexRunResult, retry: LimitRetry): Promise<Message | null> {
        const executable = result.missingExecutable || 'provider CLI';
        const provider = result.provider ? this.capitalize(result.provider) : 'Provider';
        const lines = [
            `${provider} is not installed or is not on this bot process PATH.`,
            '',
            `Missing executable: \`${executable}\``,
            result.installCommand ? `Installer: \`${result.installCommand}\`` : 'No automatic installer is configured for this provider. Add a command override in the account or settings.',
            '',
            this.trimError(result.error || result.text)
        ].filter(Boolean);
        const components: ActionRowBuilder<ButtonBuilder>[] = [];

        if (result.installCommand) {
            const id = this.createUsageSessionId();

            pendingProviderInstalls.set(id, {
                retry,
                command: result.installCommand,
                executable,
                label: result.installLabel || `Install ${provider}`,
                expiresAt: Date.now() + 5 * COMPONENT_IDLE_TTL_MS
            });
            components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${INSTALL_PROVIDER_BUTTON_ID}:${id}`)
                    .setLabel('Install and retry')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(SETTINGS_BUTTON_ID)
                    .setLabel('Settings')
                    .setStyle(ButtonStyle.Secondary)
            ));
        }

        const payload = {
            content: sanitizeDiscordText(lines.join('\n')).slice(0, 1900),
            embeds: [],
            attachments: [],
            components
        };

        if (target instanceof Message) {
            const message = await target.edit(payload).catch(async () => {
                return (target.channel as any).send(payload);
            });
            this.scheduleComponentExpiry(message as Message, components.length > 0);
            return message as Message;
        }

        const messageResult = await target.editReply(payload);
        this.scheduleComponentExpiry(messageResult as Message, components.length > 0);

        return messageResult as Message;
    }

    private async installProviderAndRetry(interaction: ButtonInteraction, installId: string): Promise<void> {
        const pending = pendingProviderInstalls.get(installId);

        if (!pending || pending.expiresAt < Date.now()) {
            pendingProviderInstalls.delete(installId);
            await interaction.reply({
                content: 'That provider install action expired.',
                flags: MessageFlags.Ephemeral
            }).catch(() => undefined);
            return;
        }
        pendingProviderInstalls.delete(installId);
        await interaction.deferUpdate();
        await interaction.editReply({
            content: `Installing ${pending.label}...\n\`${pending.command}\``,
            embeds: [],
            attachments: [],
            components: []
        });

        try {
            await execFileAsync('sh', ['-lc', pending.command], {
                cwd: this.config.defaultWorkspace,
                timeout: 5 * 60 * 1000,
                maxBuffer: 128 * 1024
            });
        } catch (error) {
            await interaction.editReply({
                content: `Install failed for \`${pending.executable}\`.\n\n${this.trimError(error instanceof Error ? error.message : String(error))}`,
                components: []
            });
            return;
        }

        await interaction.editReply({
            content: `Installed ${pending.label}. Retrying now.`,
            components: []
        });
        await this.runProviderInstallRetry(interaction, pending.retry);
    }

    private async runProviderInstallRetry(interaction: ButtonInteraction, retry: LimitRetry): Promise<void> {
        if (retry.kind === 'review') {
            await this.runReview(interaction.message as Message, retry.options);
            return;
        }

        await this.runPrompt(interaction.message as Message, retry.conversationKey, retry.prompt, {
            ...retry.options,
            fresh: false
        });
    }

    private async runPendingLimitRetry(interaction: ComponentInteraction, retryId: string, overrides: Partial<PromptOptions>): Promise<void> {
        const pending = pendingLimitRetries.get(retryId);

        if (!pending || pending.expiresAt < Date.now()) {
            pendingLimitRetries.delete(retryId);
            await interaction.followUp({
                content: 'That retry expired after 60 seconds of inactivity.',
                flags: MessageFlags.Ephemeral
            }).catch(() => undefined);
            return;
        }
        pendingLimitRetries.delete(retryId);

        if (pending.retry.kind === 'review') {
            await this.runReview(interaction.message as Message, pending.retry.options);
            return;
        }

        await this.runPrompt(interaction.message as Message, pending.retry.conversationKey, pending.retry.prompt, {
            ...pending.retry.options,
            ...overrides,
            fresh: false
        });
    }

    private async createTriagePrompt(client: Client, channelId: string, limit: number, focus: string): Promise<string> {
        const context = await collectTargetChannelContext(client, channelId, Math.min(Math.max(limit, 1), 50), 8)
            || `Could not fetch channel ${channelId}. Check bot permissions and channel access.`;
        const prompt = [
            'Triage this Discord context for bug reports, support issues, regressions, and anything that needs my attention.',
            'Prioritize the most urgent or actionable items first.',
            'Ignore or de-prioritize forum posts whose tags indicate resolved, fixed, closed, denied, duplicate, completed, or already handled unless they reveal a regression.',
            'Group duplicate reports together when they look related.',
            'For each important item, include the thread or message URL, why it matters, who is involved when visible, and the next action I should take.',
            'Call out anything that appears stale, resolved, blocked, or needs reproduction details.',
            focus ? `Focus: ${focus}` : ''
        ].filter(Boolean).join('\n');

        return withDiscordContext(prompt, context);
    }

    private withRobloxMcpGuidance(prompt: string): string {
        if (!/\b(roblox|studio|publish|production|push live|deploy)\b/i.test(prompt)) return prompt;

        return [
            prompt,
            '',
            'Roblox Studio publishing guidance:',
            'If I explicitly ask to publish, push live, or deploy the Roblox place, use the configured Roblox Studio MCP tools when available.',
            this.config.extensionRobloxApiKey ? 'The Roblox extension has an Open Cloud key available as ROBLOX_API_KEY. Do not print or reveal it.' : 'If Open Cloud publishing is needed, report that the Roblox extension key is not configured.',
            this.config.extensionRobloxUniverseId ? `Configured Roblox universe target: ${this.config.extensionRobloxUniverseId}.` : '',
            this.config.extensionRobloxPlaceId ? `Configured Roblox place target: ${this.config.extensionRobloxPlaceId}.` : '',
            'Inspect the active Studio instance first, use Roblox Studio publish APIs through execute_luau when appropriate, and report the exact result back to Discord.',
            'Do not publish unless the user request clearly asks for publishing, production, deployment, or pushing live.'
        ].filter(Boolean).join('\n');
    }

    private withImageGenerationGuidance(prompt: string): string {
        if (!/\b(generate|create|make|edit|render)\b/i.test(prompt) || !/\b(image|picture|photo|illustration|sprite|icon|texture|mockup)\b/i.test(prompt)) {
            return prompt;
        }

        return [
            prompt,
            '',
            'Image generation guidance:',
            'If the active provider has an image generation or editing tool, use it directly.',
            'If it can only create files, write the generated image to a PNG, JPG, GIF, or WEBP file in the workspace and include the absolute file path in the final response so Discode can attach it.',
            'Keep image assets reasonably sized and avoid generating unnecessary intermediate files.'
        ].join('\n');
    }

    private withSubagentGuidance(prompt: string): string {
        if (!/\b(sub-?agents?|explore agents?|general agents?|parallel agents?)\b/i.test(prompt)) return prompt;

        return [
            prompt,
            '',
            'Sub-agent guidance:',
            'When the active provider exposes sub-agents, use focused explorer agents for codebase discovery and general agents for bounded implementation work.',
            'Keep delegated tasks small, avoid duplicate work, and summarize which named agents contributed to the final answer.'
        ].join('\n');
    }

    private withPromptGuidance(prompt: string, tools = parseToolTags(prompt)): string {
        return this.withSubagentGuidance(this.withImageGenerationGuidance(this.withRobloxMcpGuidance(withToolTagGuidance(prompt, tools))));
    }

    private isPublishRequest(prompt: string): boolean {
        return /\b(publish|push live|push to production|deploy|release to production)\b/i.test(prompt)
            && /\b(roblox|studio|place|game|production|live)\b/i.test(prompt);
    }

    private isDirectoryExplorerRequest(prompt: string): boolean {
        return /\b(show|open|browse|list|explore)\b/i.test(prompt)
            && /\b(files?|directory|folder|workspace|project tree|file tree)\b/i.test(prompt)
            && !/\b(edit|fix|write|create|delete|remove|move|rename)\b/i.test(prompt);
    }

    private isFileUploadRequest(prompt: string): boolean {
        return /\b(upload|save|import|copy|drop|add)\b/i.test(prompt)
            && /\b(files?|attachments?|into|directory|folder|workspace)\b/i.test(prompt);
    }

    private async createNaturalToolPrompt(message: Message, client: Client, request: string): Promise<string | null> {
        if (!this.isTriageRequest(request)) return null;

        const targetChannelId = this.getFirstChannelMentionId(request) || this.getCurrentForumScopeId(message);

        if (!targetChannelId) return null;

        return this.createTriagePrompt(client, targetChannelId, 35, request);
    }

    private async showConversationPicker(interaction: ChatInputCommandInteraction): Promise<void> {
        const conversations = await listConversations();

        if (conversations.length === 0) {
            await interaction.reply({ content: `No saved ${this.botName} conversations.`, ...(await this.getSlashReplyOptions()) });
            return;
        }

        const visibleConversations = conversations.slice(0, 25);
        const chatNames = await Promise.all(visibleConversations.map(conversation => this.getConversationDisplayName(conversation)));
        const options = visibleConversations.map((conversation, index) => ({
            label: `${index + 1}. ${chatNames[index]}`.slice(0, 100),
            value: conversation.codexThreadId,
            description: `${path.basename(conversation.workspace)} ${new Date(conversation.updatedAt).toLocaleString()}`.slice(0, 100)
        }));
        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(CONVERSATION_SELECT_ID)
                .setPlaceholder(`Load a ${this.botName} conversation`)
                .addOptions(options)
        );

        await interaction.reply({
            content: 'Select a conversation to load into this Discord channel or thread.',
            components: [row],
            ...(await this.getSlashReplyOptions())
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, true);
    }

    private async showChatsDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply(await this.getSlashReplyOptions());
        const conversations = await listConversations();
        const chatNames = await Promise.all(conversations.slice(0, 25).map(conversation => this.getConversationDisplayName(conversation)));
        const image = await renderChatCard(conversations.slice(0, 25).map((conversation, index) => ({
            index: index + 1,
            name: chatNames[index],
            workspace: path.basename(conversation.workspace),
            updatedAt: this.formatDate(conversation.updatedAt)
        })));
        const components = conversations.length === 0 ? [] : [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(CHAT_LINK_SELECT_ID)
                    .setPlaceholder('Open latest chat message')
                    .addOptions(conversations.slice(0, 25).map((conversation, index) => ({
                        label: `${index + 1}. ${chatNames[index]}`.slice(0, 100),
                        value: conversation.codexThreadId,
                        description: `${path.basename(conversation.workspace)} ${this.formatDate(conversation.updatedAt)}`.slice(0, 100)
                    })))
            )
        ];

        await interaction.editReply({
            content: '',
            embeds: [],
            attachments: [],
            components,
            files: [new AttachmentBuilder(image, { name: `${this.commandName}-chats.png` })]
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, components.length > 0);
    }

    private async archiveCurrentThread(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.channel?.isThread()) {
            await interaction.reply({ content: `Run this inside the ${this.botName} thread you want to archive.`, ...(await this.getSlashReplyOptions()) });
            return;
        }

        await clearConversation(interaction.channelId);
        await interaction.reply({ content: `Archived this ${this.botName} conversation.`, ...(await this.getSlashReplyOptions()) });
        await interaction.channel.setArchived(true).catch(() => undefined);
    }

    private async showUsageDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
        await interaction.deferReply(await this.getSlashReplyOptions());
        const dashboard = await this.createUsageDashboard();

        await interaction.editReply({
            content: '',
            embeds: [],
            attachments: [],
            components: dashboard.components,
            files: dashboard.files
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, dashboard.components.length > 0);
    }

    private async getSlashReplyOptions(): Promise<{ flags?: 64 }> {
        const settings = await getBridgeSettings();

        return getEffectiveSlashResponsesEphemeral(settings) ? { flags: 64 as const } : {};
    }

    private async showSettingsDashboard(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction, page: SettingsPage = 'runtime'): Promise<void> {
        const settings = await getBridgeSettings();
        const image = await renderSettingsCard(settings, this.config, page);
        const payload = {
            content: '',
            embeds: [],
            attachments: [],
            components: await this.createSettingsRows(page),
            files: [new AttachmentBuilder(image, { name: `discode-settings-${page}.png` })],
            ...(await this.getSlashReplyOptions())
        };

        if (interaction instanceof ChatInputCommandInteraction) {
            await interaction.reply(payload);
            this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, payload.components.length > 0);
            return;
        }

        await interaction.reply(payload);
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, payload.components.length > 0);
    }

    private async showModelPicker(interaction: ButtonInteraction): Promise<void> {
        const settings = await getBridgeSettings();
        const model = getEffectiveModel(settings, this.config.defaultModel);
        const provider = getEffectiveProvider(settings, this.config.defaultProvider);
        const models = await this.getModelChoices(provider);
        const sessionId = this.createUsageSessionId();
        const pages = this.chunkModels(models, 23);

        modelPickerSessions.set(sessionId, {
            id: sessionId,
            provider,
            createdAt: Date.now(),
            pages
        });

        await interaction.reply({
            ...this.createModelPickerPayload(sessionId, 0, model),
            flags: MessageFlags.Ephemeral
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, true);
    }

    private async showReasoningPicker(interaction: ButtonInteraction): Promise<void> {
        const settings = await getBridgeSettings();
        const reasoning = getEffectiveReasoning(settings);

        await interaction.reply({
            content: '',
            components: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(REASONING_SELECT_ID)
                        .setPlaceholder(`Reasoning: ${this.formatReasoning(reasoning)}`)
                        .addOptions(reasoningChoices.map(choice => ({
                            label: choice.label,
                            value: choice.value,
                            description: choice.description,
                            default: choice.value === reasoning
                        })))
                )
            ],
            flags: MessageFlags.Ephemeral
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, true);
    }

    private async showTokenStats(interaction: ChatInputCommandInteraction | ButtonInteraction, conversationKey: string): Promise<void> {
        const stats = await getTokenStats(conversationKey);

        if (!stats) {
            if (interaction instanceof ChatInputCommandInteraction) {
                await interaction.reply({
                    content: 'No token usage stats are stored for this conversation yet.',
                    ...(await this.getSlashReplyOptions())
                });
            } else {
                await interaction.reply({
                    content: 'No token usage stats are stored for this conversation yet.',
                    flags: 64
                });
            }
            return;
        }

        const file = new AttachmentBuilder(await renderUsageStatsCard(stats), { name: 'token-usage-stats.png' });

        if (interaction instanceof ChatInputCommandInteraction) {
            await interaction.reply({
                content: '',
                embeds: [],
                files: [file],
                ...(await this.getSlashReplyOptions())
            });
            return;
        }

        await interaction.reply({
            content: '',
            embeds: [],
            files: [file],
            flags: 64
        });
    }

    private async showAddAccountProviderPicker(interaction: ButtonInteraction): Promise<void> {
        await interaction.reply({
            content: 'Choose the provider to add. API keys are stored only in the local Discode account file.',
            components: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(ADD_ACCOUNT_PROVIDER_SELECT_ID)
                        .setPlaceholder('Provider')
                        .addOptions(providerChoices.map(choice => ({
                            label: choice.label,
                            value: choice.value,
                            description: choice.description
                        })))
                )
            ],
            flags: MessageFlags.Ephemeral
        });
    }

    private createAddAccountModal(provider: ProviderType): ModalBuilder {
        return new ModalBuilder()
            .setCustomId(`${ADD_ACCOUNT_MODAL_ID}:${provider}`)
            .setTitle(`Add ${this.capitalize(provider)} account`)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('name')
                        .setLabel('Account name')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('apiKey')
                        .setLabel(`${this.defaultApiKeyName(provider)} or login note`)
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('email')
                        .setLabel('Email or label')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('priority')
                        .setLabel('Priority')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('command')
                        .setLabel('Command override')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                )
            );
    }

    private createModelPickerPayload(sessionId: string, page: number, activeModel?: string): { content: string; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } {
        const session = modelPickerSessions.get(sessionId);

        if (!session) {
            return {
                content: 'That model picker expired.',
                components: []
            };
        }
        const pageCount = Math.max(1, session.pages.length);
        const normalizedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const models = session.pages[normalizedPage] || [];

        session.createdAt = Date.now();

        return {
            content: '',
            components: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(MODEL_SELECT_ID)
                        .setPlaceholder(`Model page ${normalizedPage + 1}/${pageCount}`)
                        .addOptions([
                            {
                                label: 'Config default',
                                value: DEFAULT_MODEL_CHOICE,
                                description: 'Use the configured provider default.',
                                default: !activeModel || activeModel === 'config default'
                            },
                            ...models.map(model => ({
                                label: model.name.slice(0, 100),
                                value: model.value.slice(0, 100),
                                description: `${model.provider}${model.reasoning ? ' · thinking' : ''}${model.toolCall ? ' · tools' : ''}`.slice(0, 100),
                                default: activeModel === model.value
                            }))
                        ])
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`${MODEL_PICKER_PREV_ID}:${sessionId}:${Math.max(0, normalizedPage - 1)}`)
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(normalizedPage === 0),
                    new ButtonBuilder()
                        .setCustomId(`${MODEL_PICKER_NEXT_ID}:${sessionId}:${Math.min(pageCount - 1, normalizedPage + 1)}`)
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(normalizedPage >= pageCount - 1)
                )
            ]
        };
    }

    private async getModelChoices(provider: ProviderType): Promise<ModelChoiceMetadata[]> {
        try {
            const catalog = await listAvailableModels(provider);

            if (catalog.length > 0) return catalog;
        } catch (error) {
            console.warn('Failed to read model catalog:', error);
        }

        return listModelChoices().map(choice => ({
            name: choice.name,
            value: choice.value,
            provider: provider === 'codex' ? 'Codex' : this.capitalize(provider),
            reasoning: false,
            toolCall: false
        }));
    }

    private chunkModels(models: ModelChoiceMetadata[], size: number): ModelChoiceMetadata[][] {
        const chunks: ModelChoiceMetadata[][] = [];

        for (let index = 0; index < models.length; index += size) {
            chunks.push(models.slice(index, index + size));
        }

        return chunks.length > 0 ? chunks : [[]];
    }

    private async showWorkspaceDashboard(interaction: ChatInputCommandInteraction | ModalSubmitInteraction): Promise<void> {
        const dashboard = await this.createWorkspaceDashboard();

        await interaction.reply({
            content: '',
            embeds: [],
            components: dashboard.components,
            files: dashboard.files,
            ...(await this.getSlashReplyOptions())
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, dashboard.components.length > 0);
    }

    private async showFileExplorer(interaction: ChatInputCommandInteraction | ButtonInteraction, workspace?: string): Promise<void> {
        const project = await this.resolveProject(workspace || undefined);
        const session = await this.createFileExplorerSession(project.workspace, project.workspace);
        const view = await this.createFileExplorerView(session.id);
        const payload = {
            content: '',
            embeds: [],
            attachments: [],
            components: view.components,
            files: view.files
        };

        if (interaction instanceof ButtonInteraction) {
            await interaction.update(payload);
            this.trackFileExplorerFocus(interaction.channelId, session);
            this.scheduleComponentExpiry(interaction.message, true);
            return;
        }

        await interaction.reply({
            ...payload,
            ...(await this.getSlashReplyOptions())
        });
        this.trackFileExplorerFocus(interaction.channelId, session);
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, true);
    }

    private async sendFileExplorerMessage(message: Message, request: string): Promise<void> {
        const project = await this.resolveNaturalProject(request) || await this.resolveProject();
        const session = await this.createFileExplorerSession(project.workspace, project.workspace);
        const view = await this.createFileExplorerView(session.id);

        const reply = await message.reply({
            content: '',
            embeds: [],
            components: view.components,
            files: view.files
        });
        this.trackFileExplorerFocus(message.channelId, session);
        this.scheduleComponentExpiry(reply, true);
    }

    private async createFileExplorerSession(root: string, cwd: string): Promise<FileExplorerSession> {
        const session: FileExplorerSession = {
            id: this.createUsageSessionId(),
            root,
            cwd: this.resolveSafePath(root, cwd) || root,
            createdAt: Date.now(),
            entries: []
        };

        session.entries = await this.readDirectoryEntries(session.cwd);
        fileExplorerSessions.set(session.id, session);
        this.pruneTransientSessions();

        return session;
    }

    private async createFileExplorerView(sessionId: string): Promise<DashboardView> {
        const session = fileExplorerSessions.get(sessionId);

        if (!session) {
            return {
                components: [],
                files: []
            };
        }
        session.entries = await this.readDirectoryEntries(session.cwd);
        session.createdAt = Date.now();
        const image = await renderFileExplorerCard({
            title: path.basename(session.cwd) || 'Directory',
            workspace: session.cwd,
            entries: session.entries,
            generatedAt: new Date().toLocaleString()
        });
        const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
        const options = session.entries.slice(0, 25).map((entry, index) => ({
            label: `${entry.kind === 'dir' ? 'Open' : 'Send'} ${entry.name}`.slice(0, 100),
            value: String(index),
            description: `${entry.kind === 'dir' ? 'Directory' : 'File'} - ${entry.size}`.slice(0, 100)
        }));

        if (options.length > 0) {
            components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${FILE_EXPLORER_SELECT_ID}:${session.id}`)
                    .setPlaceholder('Select a directory or file')
                    .addOptions(options)
            ));
        }
        components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${FILE_EXPLORER_UP_ID}:${session.id}`)
                .setLabel('Up')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(path.resolve(session.cwd) === path.resolve(session.root)),
            new ButtonBuilder()
                .setCustomId(`${FILE_EXPLORER_ZIP_ID}:${session.id}`)
                .setLabel('Zip directory')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${FILE_EXPLORER_UPLOAD_ID}:${session.id}`)
                .setLabel('Upload file')
                .setStyle(ButtonStyle.Primary)
        ));

        return {
            components,
            files: [new AttachmentBuilder(image, { name: `${this.commandName}-files.png` })]
        };
    }

    private async readDirectoryEntries(workspace: string): Promise<FileExplorerSessionEntry[]> {
        const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);

        return entries
            .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'dist')
            .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
            .slice(0, 25)
            .map(entry => {
                const fullPath = path.join(workspace, entry.name);
                const stats = statSync(fullPath, { throwIfNoEntry: false });

                return {
                    name: entry.name,
                    kind: entry.isDirectory() ? 'dir' as const : 'file' as const,
                    size: entry.isDirectory() ? `${this.countImmediateChildren(fullPath)} items` : this.formatBytes(stats?.size || 0),
                    fullPath
                };
            });
    }

    private countImmediateChildren(directory: string): number {
        try {
            return readdirSync(directory).filter(name => !name.startsWith('.')).length;
        } catch {
            return 0;
        }
    }

    private formatBytes(value: number): string {
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;

        return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    private async handleFileExplorerSelection(interaction: StringSelectMenuInteraction, sessionId: string, value: string): Promise<void> {
        const session = fileExplorerSessions.get(sessionId);
        const index = Number(value);
        const entry = session?.entries[index];

        if (!session || !entry) {
            await interaction.editReply({ content: 'That file explorer session expired.', components: [] });
            return;
        }

        if (entry.kind === 'dir') {
            session.cwd = entry.fullPath;
            session.entries = await this.readDirectoryEntries(session.cwd);
            this.trackFileExplorerFocus(interaction.channelId, session);
            await this.updateFileExplorerReply(interaction, session.id);
            return;
        }

        await this.sendSelectedFile(interaction, entry.fullPath);
        this.trackFileExplorerFocus(interaction.channelId, session);
        await this.updateFileExplorerReply(interaction, session.id);
    }

    private async moveFileExplorerUp(interaction: ButtonInteraction, sessionId: string): Promise<void> {
        const session = fileExplorerSessions.get(sessionId);

        if (!session) {
            await interaction.editReply({ content: 'That file explorer session expired.', components: [] });
            return;
        }
        const parent = this.resolveSafePath(session.root, path.dirname(session.cwd));

        if (parent) {
            session.cwd = parent;
            session.entries = await this.readDirectoryEntries(session.cwd);
        }
        this.trackFileExplorerFocus(interaction.channelId, session);
        await this.updateFileExplorerReply(interaction, session.id);
    }

    private async sendDirectoryZip(interaction: ButtonInteraction, sessionId: string): Promise<void> {
        const session = fileExplorerSessions.get(sessionId);

        if (!session) {
            await interaction.followUp({ content: 'That file explorer session expired.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
            return;
        }
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'discode-zip-'));
        const archivePath = path.join(tempDir, `${this.cleanFileName(path.basename(session.cwd) || 'directory')}.zip`);

        try {
            await execFileAsync('zip', ['-rq', archivePath, '.'], {
                cwd: session.cwd,
                timeout: 60 * 1000,
                maxBuffer: 128 * 1024
            });
            const stats = statSync(archivePath, { throwIfNoEntry: false });

            if (!stats?.isFile() || stats.size > MAX_ATTACHMENT_BYTES) {
                await interaction.followUp({
                    content: `The zip is too large to send (${stats ? this.formatBytes(stats.size) : 'unknown size'}).`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }
            await interaction.followUp({
                content: `Zipped \`${this.shortenPathTarget(session.cwd)}\`.`,
                files: [new AttachmentBuilder(archivePath, { name: path.basename(archivePath) })]
            });
        } catch (error) {
            await interaction.followUp({
                content: `Could not zip this directory.\n\n${this.trimError(error instanceof Error ? error.message : String(error))}`,
                flags: MessageFlags.Ephemeral
            });
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private async sendSelectedFile(interaction: StringSelectMenuInteraction, filePath: string): Promise<void> {
        const stats = statSync(filePath, { throwIfNoEntry: false });

        if (!stats?.isFile()) {
            await interaction.followUp({ content: 'That file is no longer readable.', flags: MessageFlags.Ephemeral });
            return;
        }
        if (stats.size > MAX_ATTACHMENT_BYTES) {
            await interaction.followUp({
                content: `That file is too large to send (${this.formatBytes(stats.size)}).`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        await interaction.followUp({
            content: `Sending \`${this.shortenPathTarget(filePath)}\`.`,
            files: [new AttachmentBuilder(filePath, { name: path.basename(filePath) })]
        });
    }

    private async updateFileExplorerReply(interaction: ComponentInteraction, sessionId: string): Promise<void> {
        const view = await this.createFileExplorerView(sessionId);

        await interaction.editReply({
            content: '',
            embeds: [],
            attachments: [],
            components: view.components,
            files: view.files
        });
        this.scheduleComponentExpiry(interaction.message, view.components.length > 0);
    }

    private async refreshFileExplorerMessage(message: Message | null | undefined, sessionId: string): Promise<void> {
        if (!message) return;
        const view = await this.createFileExplorerView(sessionId);

        await message.edit({
            content: '',
            embeds: [],
            attachments: [],
            components: view.components,
            files: view.files
        }).catch(() => undefined);
        this.scheduleComponentExpiry(message, view.components.length > 0);
    }

    private createFileUploadModal(sessionId: string): ModalBuilder {
        return new ModalBuilder()
            .setCustomId(`${FILE_UPLOAD_MODAL_ID}:${sessionId}`)
            .setTitle('Upload into directory')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('source')
                        .setLabel('Local file path or attachment URL')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                )
            );
    }

    private async importFileIntoDirectory(source: string, directory: string): Promise<string> {
        const targetName = this.cleanFileName(path.basename(source.split('?')[0] || 'upload'));
        const targetPath = path.join(directory, targetName || 'upload');

        if (/^https?:\/\//i.test(source)) {
            const response = await fetch(source);

            if (!response.ok) return `Download failed: HTTP ${response.status}.`;
            const buffer = Buffer.from(await response.arrayBuffer());

            if (buffer.byteLength > MAX_ATTACHMENT_BYTES) return `That file is too large (${this.formatBytes(buffer.byteLength)}).`;
            await writeFile(targetPath, buffer);

            return `Uploaded \`${path.basename(targetPath)}\` into \`${this.shortenPathTarget(directory)}\`.`;
        }

        const localPath = this.expandHomePath(source);
        const stats = statSync(localPath, { throwIfNoEntry: false });

        if (!stats?.isFile()) return 'That local path is not a readable file.';
        if (stats.size > MAX_ATTACHMENT_BYTES) return `That file is too large (${this.formatBytes(stats.size)}).`;
        await copyFile(localPath, path.join(directory, this.cleanFileName(path.basename(localPath))));

        return `Uploaded \`${path.basename(localPath)}\` into \`${this.shortenPathTarget(directory)}\`.`;
    }

    private async saveUploadedAttachments(message: Message, request: string): Promise<void> {
        const project = await this.resolveNaturalProject(request) || await this.resolveProject();
        const focus = this.getFileExplorerFocus(message.channelId, project.workspace);
        const results: string[] = [];

        for (const attachment of message.attachments.values()) {
            const name = this.cleanFileName(attachment.name || path.basename(new URL(attachment.url).pathname) || 'upload');
            const response = await fetch(attachment.url).catch(() => null);

            if (!response?.ok) {
                results.push(`${name}: download failed`);
                continue;
            }
            const buffer = Buffer.from(await response.arrayBuffer());

            if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
                results.push(`${name}: too large`);
                continue;
            }
            await writeFile(path.join(focus.cwd, name), buffer);
            results.push(`${name}: saved`);
        }

        const session = await this.createFileExplorerSession(focus.root, focus.cwd);
        const view = await this.createFileExplorerView(session.id);
        const reply = await message.reply({
            content: `Uploaded to \`${this.shortenPathTarget(focus.cwd)}\`.\n${results.join('\n')}`,
            embeds: [],
            components: view.components,
            files: view.files
        });
        this.trackFileExplorerFocus(message.channelId, session);
        this.scheduleComponentExpiry(reply, true);
    }

    private trackFileExplorerFocus(channelId: string, session: FileExplorerSession): void {
        fileExplorerFocusByChannel.set(channelId, {
            root: session.root,
            cwd: session.cwd,
            updatedAt: Date.now()
        });
    }

    private getFileExplorerFocus(channelId: string, fallbackRoot: string): FileExplorerFocus {
        const focus = fileExplorerFocusByChannel.get(channelId);

        if (focus && Date.now() - focus.updatedAt <= 30 * 60 * 1000 && this.resolveSafePath(focus.root, focus.cwd)) {
            return focus;
        }

        return {
            root: fallbackRoot,
            cwd: fallbackRoot,
            updatedAt: Date.now()
        };
    }

    private resolveSafePath(root: string, target: string): string | null {
        const resolvedRoot = path.resolve(root);
        const resolvedTarget = path.resolve(target);

        if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
            return resolvedTarget;
        }

        return null;
    }

    private cleanFileName(value: string): string {
        return value.replace(/[\\/:\0]/g, '-').trim().slice(0, 120) || 'upload';
    }

    private async showTerminalDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
        const project = await this.resolveProject();
        const git = await this.getGitStatus(project.workspace);
        const image = await renderTerminalCard({
            workspace: project.workspace,
            branch: git.branch,
            clean: git.clean,
            generatedAt: new Date().toLocaleString()
        });
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(TERMINAL_RUN_BUTTON_ID)
                .setLabel('Run command')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(WORKSPACE_ADD_BUTTON_ID)
                .setLabel('Add directory')
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
            content: '',
            embeds: [],
            components: [row],
            files: [new AttachmentBuilder(image, { name: `${this.commandName}-terminal.png` })],
            ...(await this.getSlashReplyOptions())
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, true);
    }

    private async showMcpDashboard(interaction: ChatInputCommandInteraction | ModalSubmitInteraction): Promise<void> {
        const servers = await listMcpServers();
        const image = await renderMcpCard(servers);
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(MCP_ADD_BUTTON_ID)
                .setLabel('Add MCP')
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({
            content: '',
            embeds: [],
            components: [row],
            files: [new AttachmentBuilder(image, { name: `${this.commandName}-mcps.png` })],
            ...(await this.getSlashReplyOptions())
        });
        this.scheduleComponentExpiry(await interaction.fetchReply().catch(() => null) as Message | null, true);
    }

    private async createWorkspaceDashboard(): Promise<DashboardView> {
        const { activeProjectName, projects } = await listProjects();
        const active = await getActiveProject() || { name: 'Default', workspace: this.config.defaultWorkspace, model: this.config.defaultModel, updatedAt: new Date().toISOString() };
        const git = await this.getGitStatus(active.workspace);
        const image = await renderWorkspaceCard({
            activeName: active.name,
            activeWorkspace: active.workspace,
            git,
            projects: projects.map((project, index) => ({
                index: index + 1,
                name: project.name,
                workspace: project.workspace,
                active: project.name.trim().toLowerCase() === activeProjectName
            })),
            generatedAt: new Date().toLocaleString()
        });
        const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(WORKSPACE_ADD_BUTTON_ID)
                    .setLabel('Add directory')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(FILE_EXPLORER_BUTTON_ID)
                    .setLabel('Browse files')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(TERMINAL_RUN_BUTTON_ID)
                    .setLabel('Run terminal')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(MCP_ADD_BUTTON_ID)
                    .setLabel('Add MCP')
                    .setStyle(ButtonStyle.Secondary)
            )
        ];

        if (projects.length > 0) {
            rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(WORKSPACE_SELECT_ID)
                    .setPlaceholder('Switch directory')
                    .addOptions(projects.slice(0, 25).map((project, index) => ({
                        label: `${index + 1}. ${project.name}`.slice(0, 100),
                        value: project.name,
                        description: this.shortenPathTarget(project.workspace).slice(0, 100),
                        default: project.name.trim().toLowerCase() === activeProjectName
                    })))
            ));
        }

        return {
            components: rows,
            files: [new AttachmentBuilder(image, { name: `${this.commandName}-workspace.png` })]
        };
    }

    private async updateSettingsDashboard(interaction: StringSelectMenuInteraction, page: SettingsPage): Promise<void> {
        const settings = await getBridgeSettings();
        const image = await renderSettingsCard(settings, this.config, page);

        await interaction.update({
            content: '',
            embeds: [],
            attachments: [],
            components: await this.createSettingsRows(page),
            files: [new AttachmentBuilder(image, { name: `discode-settings-${page}.png` })]
        });
        this.scheduleComponentExpiry(interaction.message, true);
    }

    private async createUsageDashboard(page = 0): Promise<UsageDashboardView> {
        this.pruneUsageDashboardSessions();
        const accounts = await this.accounts.listAccounts();
        const rawState = await this.accounts.readState();
        const rawAccounts = rawState?.accounts || [];
        const usages = new Map<string, AccountUsage>();
        const sessionId = this.createUsageSessionId();

        await Promise.all(rawAccounts.map(async account => {
            usages.set(account.id, await fetchAccountUsage(account));
        }));

        const accountPages = await Promise.all(accounts.map((_account, index) => renderUsageCard(this.createUsageCardData(accounts, usages, index))));
        const pages = [
            await renderUsageOverviewCard(this.createUsageOverviewData(accounts, usages)),
            ...accountPages
        ];

        usageDashboardSessions.set(sessionId, {
            id: sessionId,
            createdAt: Date.now(),
            accounts,
            pages
        });

        return this.createUsageDashboardView(sessionId, page) || {
            components: [],
            files: [new AttachmentBuilder(pages[0], { name: `${this.commandName}-usage.png` })]
        };
    }

    private createUsageDashboardView(sessionId: string, page: number): UsageDashboardView | null {
        const session = usageDashboardSessions.get(sessionId);

        if (!session) return null;
        const pageCount = Math.max(1, session.pages.length);
        const normalizedPage = Math.min(Math.max(page, 0), pageCount - 1);
        session.createdAt = Date.now();

        return {
            components: this.createUsageRows(normalizedPage, sessionId, session.accounts),
            files: [new AttachmentBuilder(session.pages[normalizedPage], { name: `${this.commandName}-usage-${sessionId}-${normalizedPage + 1}.png` })]
        };
    }

    private createUsageOverviewData(accounts: AccountSummary[], usages: Map<string, AccountUsage>): UsageOverviewData {
        const providers = new Map<string, { total: number; count: number }>();

        for (const account of accounts) {
            const remaining = this.getWeeklyRemaining(usages.get(account.id));
            const entry = providers.get(account.provider) || { total: 0, count: 0 };

            if (remaining !== null) {
                entry.total += remaining;
                entry.count += 1;
            }
            providers.set(account.provider, entry);
        }

        return {
            title: `${this.botName} Usage Limits`,
            accounts: accounts.map(account => ({
                name: this.getAccountAlias(account),
                provider: account.provider,
                active: account.active,
                remainingPercent: this.getWeeklyRemaining(usages.get(account.id))
            })),
            providers: [...providers].map(([name, value]) => ({
                name: this.capitalize(name),
                accountCount: accounts.filter(account => account.provider === name).length,
                remainingPercent: value.count > 0 ? value.total / value.count : null
            })),
            generatedAt: new Date().toLocaleString()
        };
    }

    private createUsageCardData(accounts: AccountSummary[], usages: Map<string, AccountUsage>, page: number): UsageCardData {
        const pageCount = Math.max(1, accounts.length);
        const normalizedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const account = accounts[normalizedPage];
        const usage = account ? usages.get(account.id) : undefined;

        return {
            title: `${this.botName} Usage`,
            accountName: account ? this.getAccountAlias(account) : 'No accounts',
            accountIndex: account ? normalizedPage + 1 : 0,
            accountCount: accounts.length,
            plan: usage?.planType || account?.planType || 'unknown',
            provider: account?.provider || 'codex',
            credential: account?.credentialLabel || 'Not configured',
            active: account?.active || false,
            credits: usage?.creditsBalance || null,
            primary: this.createUsageCardWindow('5-hour limit', usage?.primaryWindow),
            secondary: this.createUsageCardWindow('Weekly limit', usage?.secondaryWindow),
            generatedAt: new Date().toLocaleString()
        };
    }

    private createUsageRows(page: number, sessionId: string, accounts: AccountSummary[]): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
        const pageCount = Math.max(1, accounts.length + 1);
        const normalizedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const account = normalizedPage > 0 ? accounts[normalizedPage - 1] : null;
        const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${USAGE_PREV_ID}:${sessionId}:${Math.max(0, normalizedPage - 1)}`)
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(normalizedPage === 0),
                new ButtonBuilder()
                    .setCustomId(`${USAGE_ACTIVATE_ACCOUNT_ID}:${normalizedPage}`)
                    .setLabel(account ? account.active ? 'Active account' : 'Use this account' : 'Overview')
                    .setStyle(account?.active ? ButtonStyle.Success : ButtonStyle.Primary)
                    .setDisabled(!account || account.active === true),
                new ButtonBuilder()
                    .setCustomId(`${USAGE_NEXT_ID}:${sessionId}:${Math.min(pageCount - 1, normalizedPage + 1)}`)
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(normalizedPage >= pageCount - 1),
                new ButtonBuilder()
                    .setCustomId(ADD_ACCOUNT_BUTTON_ID)
                    .setLabel('Add account')
                    .setStyle(ButtonStyle.Secondary)
            ),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${ACCOUNT_SELECT_ID}:${sessionId}`)
                    .setPlaceholder('Usage page')
                    .addOptions([
                        {
                            label: 'Overview',
                            value: '0',
                            description: 'All providers and account usage limits.',
                            default: normalizedPage === 0
                        },
                        ...accounts.slice(0, 24).map((account, index) => ({
                            label: this.getAccountAlias(account).slice(0, 100),
                            value: String(index + 1),
                            description: `Plan ${this.capitalize(account.planType)}`.slice(0, 100),
                            default: normalizedPage === index + 1
                        }))
                    ])
            )
        ];

        return rows;
    }

    private pruneUsageDashboardSessions(): void {
        const now = Date.now();

        for (const [id, session] of usageDashboardSessions) {
            if (now - session.createdAt > USAGE_DASHBOARD_TTL_MS) {
                usageDashboardSessions.delete(id);
            }
        }
    }

    private createUsageSessionId(): string {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    }
    private createUsageCardWindow(label: string, window: AccountUsage['primaryWindow']): UsageCardWindow {
        return {
            label,
            percent: window?.usedPercent === undefined || window?.usedPercent === null ? null : window.usedPercent,
            duration: window?.windowSeconds ? this.formatDuration(window.windowSeconds) : 'Unknown window',
            reset: window?.resetAt ? this.formatDate(window.resetAt) : 'unknown'
        };
    }

    private getWeeklyRemaining(usage: AccountUsage | undefined): number | null {
        const used = usage?.secondaryWindow?.usedPercent ?? usage?.primaryWindow?.usedPercent;

        if (used === undefined || used === null) return null;

        return Math.max(0, Math.min(100, 100 - used));
    }

    private formatDuration(seconds: number): string {
        if (seconds === 18000) return '5h window';
        if (seconds === 604800) return 'weekly window';
        if (seconds >= 86400) return `${Math.round(seconds / 86400)}d window`;
        if (seconds >= 3600) return `${Math.round(seconds / 3600)}h window`;

        return `${seconds}s window`;
    }

    private async recordCurrentUsageLimit(message: string): Promise<void> {
        const active = await this.accounts.getActiveAccount();

        await recordUsageLimit({
            accountId: active?.id || null,
            accountName: active?.name || null,
            message: message.slice(0, 2000),
            resetAt: this.extractResetTime(message)
        });
    }

    private isUsageLimitText(text: string): boolean {
        return /usage limit|rate limit|quota|too many requests|429|try again at|weekly limit|5.?hour/i.test(text);
    }

    private extractResetTime(text: string): string | null {
        const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/)?.[0];

        if (iso) return iso;
        const unix = text.match(/\b(?:reset|try again)[^\d]*(\d{10,13})\b/i)?.[1];

        if (unix) {
            const value = Number(unix);

            if (Number.isFinite(value)) return new Date(value > 9999999999 ? value : value * 1000).toISOString();
        }

        return null;
    }

    private formatDate(value: string): string {
        const date = new Date(value);

        if (!Number.isFinite(date.getTime())) return value || 'unknown';

        return date.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    private trimError(value: string): string {
        const clean = sanitizeDiscordText(this.formatDiscordOutput(value || '')).trim();

        return clean.length > 900 ? `${clean.slice(0, 897).trimEnd()}...` : clean;
    }

    private async sendPages(target: ResponseTarget, text: string, result?: CodexRunResult): Promise<Message | null> {
        const formatted = sanitizeDiscordText(this.formatDiscordOutput(text || `${this.botName} completed with no final message.`));
        const pages = splitDiscordText(formatted);
        const files = this.getResultAttachments(result?.text || text);
        const components = result ? await this.createRunControls() : [];
        const settings = await getBridgeSettings();
        const responseImages = Boolean(result) && getEffectiveFinalResponsesAsImages(settings);

        if (responseImages) {
            const responseCards = await renderFinalResponseCards(formatted, this.botName);
            const sessionId = this.createUsageSessionId();
            const session: ResponseCardSession = {
                id: sessionId,
                createdAt: Date.now(),
                cards: responseCards,
                extraFiles: files.slice(0, 9),
                controls: components
            };
            responseCardSessions.set(sessionId, session);
            this.pruneTransientSessions();
            const view = this.createResponseCardView(sessionId, 0);

            if (!view) return null;

            if (target instanceof Message) {
                const latest = await target.edit({ content: '', attachments: [], files: view.files, components: view.components }).catch(async () => {
                    return (target.channel as any).send({ content: '', files: view.files, components: view.components });
                });
                this.scheduleComponentExpiry(latest, view.components.length > 0, true);
                return latest || null;
            }

            const latest = await target.editReply({ content: '', attachments: [], files: view.files, components: view.components });
            this.scheduleComponentExpiry(latest as Message, view.components.length > 0, true);

            return latest as Message || null;
        }

        if (target instanceof Message) {
            let latest = await target.edit({ content: pages[0], attachments: [], files: files.slice(0, 10), components }).catch(async () => {
                return (target.channel as any).send({ content: pages[0], files: files.slice(0, 10), components });
            });
            this.scheduleComponentExpiry(latest, components.length > 0, true);

            for (const page of pages.slice(1)) {
                latest = await (target.channel as any).send(page);
            }
            return latest || null;
        }

        let latest = await target.editReply({ content: pages[0], attachments: [], files: files.slice(0, 10), components });
        this.scheduleComponentExpiry(latest as Message, components.length > 0, true);

        for (const page of pages.slice(1)) {
            latest = await target.followUp(page);
        }

        return latest || null;
    }

    private createResponseCardView(sessionId: string, page: number): DashboardView | null {
        const session = responseCardSessions.get(sessionId);

        if (!session) return null;
        const pageCount = Math.max(1, session.cards.length);
        const normalizedPage = Math.min(Math.max(page, 0), pageCount - 1);
        const files = [
            new AttachmentBuilder(session.cards[normalizedPage], { name: `discode-response-${normalizedPage + 1}.png` }),
            ...(normalizedPage === 0 ? session.extraFiles : [])
        ].slice(0, 10);
        const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

        session.createdAt = Date.now();
        if (pageCount > 1) {
            components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${RESPONSE_CARD_PREV_ID}:${sessionId}:${Math.max(0, normalizedPage - 1)}`)
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(normalizedPage === 0),
                new ButtonBuilder()
                    .setCustomId(`${RESPONSE_CARD_NEXT_ID}:${sessionId}:${Math.min(pageCount - 1, normalizedPage + 1)}`)
                    .setLabel(`Next (${normalizedPage + 1}/${pageCount})`)
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(normalizedPage >= pageCount - 1)
            ));
        }
        components.push(...session.controls);

        return {
            components,
            files
        };
    }

    private formatDiscordOutput(text: string): string {
        return text
            .replace(/\[([^\]\n]{1,120})\]\(((?:\/Users\/apple|\/var\/folders|\/tmp)[^)]+)\)/g, (_match, _label, target) => `\`${this.shortenPathTarget(target)}\``)
            .replace(/(?:\/Users\/apple|\/var\/folders|\/tmp)\/[^\s`'")>]+/g, value => `\`${this.shortenPathTarget(value)}\``);
    }

    private shortenPathTarget(value: string): string {
        const clean = value.replace(/[.,;:]+$/, '');
        const suffix = value.slice(clean.length);
        const line = clean.match(/:(\d+)$/)?.[1];
        const pathOnly = line ? clean.slice(0, -(line.length + 1)) : clean;
        let shortened = pathOnly;

        if (pathOnly.startsWith(this.config.defaultWorkspace + path.sep)) {
            shortened = path.relative(this.config.defaultWorkspace, pathOnly);
        } else if (pathOnly === this.config.defaultWorkspace) {
            shortened = path.basename(pathOnly);
        } else if (pathOnly.startsWith(os.homedir() + path.sep)) {
            shortened = `~/${path.relative(os.homedir(), pathOnly)}`;
        } else if (pathOnly.startsWith('/var/folders/') || pathOnly.startsWith('/tmp/')) {
            shortened = path.basename(pathOnly);
        }

        return `${shortened}${line ? `:${line}` : ''}${suffix}`;
    }

    private createProgressUpdater(target: ResponseTarget, agentContext = ''): { push: (label: string, text?: string) => void; flush: () => Promise<void> } {
        const lines: string[] = [];
        let idleLabel: string | null = null;
        let idleIndex = 0;
        let lastUpdate = 0;
        let lastEventAt = Date.now();
        let pending = Promise.resolve();

        const render = () => {
            const latest = idleLabel || lines.at(-1) || 'Starting';

            return latest;
        };
        const edit = async () => {
            const now = Date.now();

            if (now - lastUpdate < 2500) return;
            lastUpdate = now;
            const file = new AttachmentBuilder(await renderThinkingGif(render(), this.botName, await this.createAgentRoster(agentContext)), { name: `${this.commandName}-thinking.gif` });
            const payload = {
                content: '',
                embeds: [],
                attachments: [],
                files: [file]
            };

            if (target instanceof Message) {
                await target.edit(payload).catch(() => undefined);
            } else {
                await target.editReply(payload).catch(() => undefined);
            }
        };
        const pulse = setInterval(() => {
            if (Date.now() - lastEventAt < 9000) return;

            idleLabel = idleProgressLabels[idleIndex % idleProgressLabels.length];
            idleIndex += 1;
            pending = pending.then(edit).catch(() => undefined);
        }, 9000);
        pulse.unref?.();

        return {
            push: (label: string, text?: string) => {
                const suffix = text ? `: ${text.replace(/\s+/g, ' ').slice(0, 180)}` : '';
                idleLabel = null;
                lastEventAt = Date.now();
                lines.push(`${label}${suffix}`);
                pending = pending.then(edit).catch(() => undefined);
            },
            flush: async () => {
                clearInterval(pulse);
                await pending;
            }
        };
    }

    private async createAgentRoster(task: string): Promise<AgentStatus[]> {
        if (!this.isSubagentRequest(task)) return [];
        const settings = await getBridgeSettings();
        const names = getEffectiveAgentNames(settings);
        const normalized = task.toLowerCase();
        const roles = [
            { role: 'General', active: /\b(general|sub-?agents?|parallel agents?)\b/i.test(normalized) },
            { role: 'Explore', active: /\b(inspect|search|read|files?|workspace|directory|project|explor)/i.test(normalized) },
            { role: 'Review', active: /\b(review|test|check|verify|bug|failure|fix)\b/i.test(normalized) },
            { role: 'Implement', active: /\b(edit|build|implement|create|update|write|patch)\b/i.test(normalized) }
        ];

        return roles
            .filter(item => item.active)
            .map((item, index) => ({
                name: names[index % names.length] || `Agent ${index + 1}`,
                role: item.role,
                color: AGENT_COLORS[index % AGENT_COLORS.length],
                active: true
            }));
    }

    private isSubagentRequest(value: string): boolean {
        return /\b(sub-?agents?|explore agents?|general agents?|parallel agents?|delegate|spawn agents?)\b/i.test(value);
    }

    private withFooter(text: string, result: CodexRunResult): string {
        const footer = [];

        if (result.switchedAccountName) footer.push(result.limitError ? `Usage limit hit; switched to ${result.switchedAccountName}` : `Switched: ${result.switchedAccountName}`);

        return footer.length > 0 ? `${text}\n\n-# ${footer.join(' | ')}` : text;
    }

    private async createRunControls(): Promise<ActionRowBuilder<ButtonBuilder>[]> {
        const settings = await getBridgeSettings();
        const model = getEffectiveModel(settings, this.config.defaultModel);
        const reasoning = getEffectiveReasoning(settings);

        return [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(MODEL_BUTTON_ID)
                    .setLabel(`Model: ${model}`.slice(0, 80))
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(REASONING_BUTTON_ID)
                    .setLabel(`Reasoning: ${this.formatReasoning(reasoning)}`)
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(TOKEN_STATS_BUTTON_ID)
                    .setLabel('Token Usage Stats')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(SETTINGS_BUTTON_ID)
                    .setLabel('Settings')
                    .setStyle(ButtonStyle.Secondary)
            )
        ];
    }

    private async createSettingsRows(page: SettingsPage = 'runtime'): Promise<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[]> {
        const settings = await getBridgeSettings();
        const model = getEffectiveModel(settings, this.config.defaultModel);
        const reasoning = getEffectiveReasoning(settings);
        const provider = getEffectiveProvider(settings, this.config.defaultProvider);
        const providerPriority = getEffectiveProviderPriority(settings, this.config.defaultProviderPriority);
        const permissionMode = getEffectivePermissionMode(settings, this.config.defaultPermissionMode);
        const notifyPromptFinished = getEffectiveNotifyPromptFinished(settings, this.config.defaultReminderPings);
        const notifyPermissionRequired = getEffectiveNotifyPermissionRequired(settings);
        const notifyUsageLimit = getEffectiveNotifyUsageLimit(settings);
        const slashResponsesEphemeral = getEffectiveSlashResponsesEphemeral(settings);
        const finalResponsesAsImages = getEffectiveFinalResponsesAsImages(settings);
        const autoSwitchOnLimit = getEffectiveAutoSwitchOnLimit(settings, this.config.autoSwitchOnLimit);
        const agentNamingMode: AgentNamingMode = settings.agentNamingMode === 'custom' ? 'custom' : 'greek';
        const modelOptions = listModelChoices().map(choice => ({
            label: choice.name.slice(0, 100),
            value: choice.value,
            default: choice.value === DEFAULT_MODEL_CHOICE ? !settings.model : choice.value === model
        }));
        const reasoningOptions = reasoningChoices.map(choice => ({
            label: choice.label,
            value: choice.value,
            description: choice.description,
            default: choice.value === reasoning
        }));

        if (settings.model && !modelOptions.some(option => option.value === model)) {
            modelOptions.unshift({
                label: model.slice(0, 100),
                value: model,
                default: true
            });
        }

        const pageRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(SETTINGS_PAGE_SELECT_ID)
                .setPlaceholder(`Page: ${this.capitalize(page)}`)
                .addOptions(settingsPages.map(item => ({
                    label: this.capitalize(item),
                    value: item,
                    default: item === page
                })))
        );

        if (page === 'access') {
            return [
                pageRow,
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(PERMISSION_SELECT_ID)
                        .setPlaceholder(`Permission: ${this.formatPermissionMode(permissionMode)}`)
                        .addOptions(permissionChoices.map(choice => ({
                            label: choice.label,
                            value: choice.value,
                            description: choice.description,
                            default: choice.value === permissionMode
                        })))
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(ACCESS_USERS_BUTTON_ID)
                        .setLabel('Edit allowed users')
                        .setStyle(ButtonStyle.Secondary)
                )
            ];
        }

        if (page === 'notifications') {
            return [
                pageRow,
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(NOTIFY_DONE_SELECT_ID)
                        .setPlaceholder(`Prompt finished: ${notifyPromptFinished ? 'On' : 'Off'}`)
                        .addOptions([
                            { label: 'On', value: 'on', description: 'Notify the prompter when a run finishes.', default: notifyPromptFinished },
                            { label: 'Off', value: 'off', description: 'Do not notify when a run finishes.', default: !notifyPromptFinished }
                        ])
                ),
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(NOTIFY_PERMISSION_SELECT_ID)
                        .setPlaceholder(`Permission needed: ${notifyPermissionRequired ? 'On' : 'Off'}`)
                        .addOptions([
                            { label: 'On', value: 'on', description: 'Notify the prompter when permission is needed.', default: notifyPermissionRequired },
                            { label: 'Off', value: 'off', description: 'Do not notify for permission requests.', default: !notifyPermissionRequired }
                        ])
                ),
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(NOTIFY_LIMIT_SELECT_ID)
                        .setPlaceholder(`Usage limits: ${notifyUsageLimit ? 'On' : 'Off'}`)
                        .addOptions([
                            { label: 'On', value: 'on', description: 'Notify the prompter when a provider hits limits.', default: notifyUsageLimit },
                            { label: 'Off', value: 'off', description: 'Do not notify for usage limits.', default: !notifyUsageLimit }
                        ])
                )
            ];
        }

        if (page === 'display') {
            return [
                pageRow,
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(FINAL_RESPONSE_SELECT_ID)
                        .setPlaceholder(`Final responses: ${finalResponsesAsImages ? 'Images' : 'Text'}`)
                        .addOptions([
                            { label: 'Images', value: 'images', description: 'Render final agent replies as clean image cards.', default: finalResponsesAsImages },
                            { label: 'Text', value: 'text', description: 'Send final agent replies as Discord text.', default: !finalResponsesAsImages }
                        ])
                ),
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(AGENT_NAMING_SELECT_ID)
                        .setPlaceholder(`Agent names: ${agentNamingMode === 'custom' ? 'Custom' : 'Greek'}`)
                        .addOptions([
                            { label: 'Greek', value: 'greek', description: 'Use the built-in Greek agent roster.', default: agentNamingMode === 'greek' },
                            { label: 'Custom', value: 'custom', description: 'Use your custom agent names.', default: agentNamingMode === 'custom' }
                        ])
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(AGENT_NAMES_BUTTON_ID)
                        .setLabel('Edit agent names')
                        .setStyle(ButtonStyle.Secondary)
                ),
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(SLASH_PRIVACY_SELECT_ID)
                        .setPlaceholder(`Slash responses: ${slashResponsesEphemeral ? 'Ephemeral' : 'Public'}`)
                        .addOptions([
                            { label: 'Ephemeral', value: 'ephemeral', description: 'Only you can see slash command responses.', default: slashResponsesEphemeral },
                            { label: 'Public', value: 'public', description: 'Slash command responses are visible in chat.', default: !slashResponsesEphemeral }
                        ])
                )
            ];
        }

        if (page === 'failover') {
            return [
                pageRow,
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(FAILOVER_SELECT_ID)
                        .setPlaceholder(`Usage limit rerouting: ${autoSwitchOnLimit ? 'On' : 'Off'}`)
                        .addOptions([
                            { label: 'On', value: 'on', description: 'Try the next account or fallback provider on limits.', default: autoSwitchOnLimit },
                            { label: 'Off', value: 'off', description: 'Stop and show manual retry controls on limits.', default: !autoSwitchOnLimit }
                        ])
                ),
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(PROVIDER_PRIORITY_SELECT_ID)
                        .setPlaceholder('Fallback priority')
                        .setMinValues(1)
                        .setMaxValues(providerChoices.length)
                        .addOptions(providerChoices.map(choice => ({
                            label: choice.label,
                            value: choice.value,
                            description: choice.description,
                            default: providerPriority.includes(choice.value)
                        })))
                )
            ];
        }

        return [
            pageRow,
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(PROVIDER_SELECT_ID)
                    .setPlaceholder(`Provider: ${this.capitalize(provider)}`)
                    .addOptions(providerChoices.map(choice => ({
                        label: choice.label,
                        value: choice.value,
                        description: choice.description,
                        default: choice.value === provider
                    })))
            ),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(PROVIDER_PRIORITY_SELECT_ID)
                    .setPlaceholder('Fallback priority')
                    .setMinValues(1)
                    .setMaxValues(providerChoices.length)
                    .addOptions(providerChoices.map(choice => ({
                        label: choice.label,
                        value: choice.value,
                        description: choice.description,
                        default: providerPriority.includes(choice.value)
                    })))
            ),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(MODEL_SELECT_ID)
                    .setPlaceholder(`Model: ${model}`)
                    .addOptions(modelOptions.slice(0, 25))
            ),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(REASONING_SELECT_ID)
                    .setPlaceholder(`Reasoning: ${this.formatReasoning(reasoning)}`)
                    .addOptions(reasoningOptions)
            )
        ];
    }

    private formatReasoning(reasoning: ReasoningEffort): string {
        return reasoning === 'xhigh' ? 'XHigh' : reasoning.charAt(0).toUpperCase() + reasoning.slice(1);
    }

    private formatPermissionMode(permissionMode: PermissionMode): string {
        if (permissionMode === 'directory') return 'Directory only';
        if (permissionMode === 'auto-review') return 'Auto-review';

        return 'Full access';
    }

    private defaultApiKeyName(provider: ProviderType): string {
        if (provider === 'anthropic') return 'ANTHROPIC_API_KEY';
        if (provider === 'zai') return 'ZAI_API_KEY';
        if (provider === 'qwen') return 'QWEN_API_KEY';

        return 'OPENAI_API_KEY';
    }

    private createWorkspaceModal(): ModalBuilder {
        return new ModalBuilder()
            .setCustomId(WORKSPACE_ADD_MODAL_ID)
            .setTitle('Add directory')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('name')
                        .setLabel('Name')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('workspace')
                        .setLabel('Directory path')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('model')
                        .setLabel('Model')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                )
            );
    }

    private createTerminalModal(): ModalBuilder {
        return new ModalBuilder()
            .setCustomId(TERMINAL_RUN_MODAL_ID)
            .setTitle('Run terminal command')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('command')
                        .setLabel('Command')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('timeout')
                        .setLabel('Timeout seconds')
                        .setStyle(TextInputStyle.Short)
                        .setValue('120')
                        .setRequired(false)
                )
            );
    }

    private createMcpModal(): ModalBuilder {
        return new ModalBuilder()
            .setCustomId(MCP_ADD_MODAL_ID)
            .setTitle('Add MCP server')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('name')
                        .setLabel('Name')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('command')
                        .setLabel('Command')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('args')
                        .setLabel('Args')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                )
            );
    }

    private async createAccessUsersModal(): Promise<ModalBuilder> {
        const settings = await getBridgeSettings();
        const allowedUserIds = Array.from(new Set([
            ...this.config.allowedUserIds,
            ...(settings.allowedUserIds || [])
        ].map(value => value.trim()).filter(Boolean)));
        const primaryAllowedUserId = settings.primaryAllowedUserId || this.config.primaryAllowedUserId || allowedUserIds[0] || '';

        return new ModalBuilder()
            .setCustomId(ACCESS_USERS_MODAL_ID)
            .setTitle('Allowed users')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('allowedUsers')
                        .setLabel('Allowed Discord user IDs')
                        .setStyle(TextInputStyle.Paragraph)
                        .setValue(allowedUserIds.join(', '))
                        .setRequired(true)
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('primaryUser')
                        .setLabel('Primary notification user ID')
                        .setStyle(TextInputStyle.Short)
                        .setValue(primaryAllowedUserId)
                        .setRequired(false)
                )
            );
    }

    private async createAgentNamesModal(): Promise<ModalBuilder> {
        const settings = await getBridgeSettings();
        const names = Array.isArray(settings.customAgentNames) ? settings.customAgentNames : [];

        return new ModalBuilder()
            .setCustomId(AGENT_NAMES_MODAL_ID)
            .setTitle('Agent names')
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('agentNames')
                        .setLabel('Names, comma separated')
                        .setStyle(TextInputStyle.Paragraph)
                        .setValue(names.join(', '))
                        .setRequired(false)
                )
            );
    }

    private async getGitStatus(workspace: string): Promise<WorkspaceCardGit> {
        try {
            const branch = (await execFileAsync('git', ['branch', '--show-current'], { cwd: workspace })).stdout.trim() || 'detached';
            const status = (await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], { cwd: workspace })).stdout.trim();
            const lines = status.split('\n').filter(Boolean);
            const header = lines[0] || '';
            const ahead = Number(header.match(/ahead (\d+)/)?.[1] || 0);
            const behind = Number(header.match(/behind (\d+)/)?.[1] || 0);
            const changes = Math.max(0, lines.length - (header.startsWith('##') ? 1 : 0));

            return {
                branch,
                changes,
                ahead,
                behind,
                clean: changes === 0,
                available: true
            };
        } catch {
            return {
                branch: 'none',
                changes: 0,
                ahead: 0,
                behind: 0,
                clean: true,
                available: false
            };
        }
    }

    private getResultAttachments(text: string): AttachmentBuilder[] {
        const matches = text.match(/(?:\/Users\/apple|\/var\/folders|\/tmp)\/[^\s`'")>]+/g) || [];
        const files: AttachmentBuilder[] = [];

        for (const rawPath of [...new Set(matches)]) {
            const cleanPath = rawPath.replace(/[.,;:]+$/, '');
            const extension = path.extname(cleanPath).toLowerCase();

            if (!ATTACHMENT_EXTENSIONS.has(extension)) continue;
            if (!existsSync(cleanPath)) continue;
            const stat = statSync(cleanPath);

            if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) continue;
            files.push(new AttachmentBuilder(cleanPath));
        }

        return files;
    }

    private extractImagePaths(text: string): string[] {
        const matches = text.match(/(?:\/Users\/apple|\/var\/folders|\/tmp)\/[^\s`'")>]+/g) || [];
        const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
        const paths: string[] = [];

        for (const rawPath of [...new Set(matches)]) {
            const cleanPath = rawPath.replace(/[.,;:]+$/, '');
            const extension = path.extname(cleanPath).toLowerCase();

            if (!imageExtensions.has(extension)) continue;
            if (!existsSync(cleanPath)) continue;
            const stat = statSync(cleanPath);

            if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) continue;
            paths.push(cleanPath);
        }

        return paths.slice(0, 8);
    }

    private extractMentionPrompt(message: Message, client: Client): string | null {
        if (!client.user || !message.mentions.has(client.user)) return null;

        return message.content
            .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
            .trim();
    }

    private shouldIgnoreThreadMessage(message: Message): boolean {
        if (message.attachments.size > 0) return false;
        if (this.hasContextReference(message.content)) return false;

        const cleaned = message.content
            .replace(/<@!?\d+>/g, '')
            .replace(/<@&\d+>/g, '')
            .replace(/<a?:\w+:\d+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned.length === 0;
    }

    private getMessageRequest(message: Message, prompt: string | null): string {
        const content = prompt ?? message.content.trim();

        if (content && this.hasContextReference(content) && !this.stripContextReferences(content)) {
            return 'Review the referenced Discord context and identify what needs attention.';
        }
        if (content) return content;
        if (message.attachments.size > 0) return 'Review the attached file or screenshot.';
        if (this.hasContextReference(message.content)) return 'Review the referenced Discord context and identify what needs attention.';

        return '';
    }

    private hasContextReference(content: string): boolean {
        return /<#\d+>/.test(content)
            || /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/\d+\/\d+/.test(content);
    }

    private stripContextReferences(content: string): string {
        return content
            .replace(/<#\d+>/g, '')
            .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/\d+\/\d+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private getFirstChannelMentionId(content: string): string | null {
        return content.match(/<#(\d+)>/)?.[1] || null;
    }

    private getCurrentForumScopeId(message: Message): string | null {
        const channel = message.channel as any;

        if (channel?.type === 15) return channel.id;
        if (channel?.isThread?.() && channel.parent?.type === 15) return channel.parentId;

        return null;
    }

    private isTriageRequest(request: string): boolean {
        const normalized = request.toLowerCase();

        if (/\b(triage|prioritize|prioritise)\b/.test(normalized)) return true;
        if (normalized.includes('what needs my attention')) return true;
        if (/\b(bug reports?|support issues?|regressions?|forum threads?|open issues?)\b/.test(normalized)
            && /\b(review|summarize|summarise|scan|check|audit|rank)\b/.test(normalized)) return true;

        return false;
    }

    private async isAuthorized(userId: string): Promise<boolean> {
        return (await this.getAllowedUserIds()).includes(userId);
    }

    private async notifyUpdateIfNeeded(target: ResponseTarget): Promise<void> {
        const status = await checkForUpdate(process.cwd());

        if (!status.updateAvailable) return;
        if (!(await shouldNotifyUpdate(process.cwd(), 'discordLatest', status.latest))) return;
        const notice = formatUpdateNotice(status);

        if (!notice) return;
        await markUpdateNotified(process.cwd(), 'discordLatest', status.latest);

        if (target instanceof Message) {
            await target.reply(notice).catch(() => undefined);
            return;
        }
        const channel = target.channel;

        if (channel && 'send' in channel) {
            await (channel as any).send(`${await this.getUserMention(target.user.id)} ${notice}`).catch(() => undefined);
        }
    }

    private async getAllowedUserIds(): Promise<string[]> {
        const settings = await getBridgeSettings();

        return Array.from(new Set([
            ...this.config.allowedUserIds,
            ...(settings.allowedUserIds || [])
        ].map(value => value.trim()).filter(Boolean)));
    }

    private async getUserMention(requesterId?: string, target?: ResponseTarget): Promise<string> {
        const settings = await getBridgeSettings();
        const allowedUserIds = await this.getAllowedUserIds();
        const userId = requesterId
            || (target instanceof Message ? target.author.id : target?.user.id)
            || settings.primaryAllowedUserId
            || this.config.primaryAllowedUserId
            || allowedUserIds[0];

        return userId ? `<@${userId}>` : '';
    }

    private parseUserIds(value: string): string[] {
        return Array.from(new Set((value.match(/\d{15,25}/g) || []).map(item => item.trim()).filter(Boolean)));
    }

    private async expireInactiveComponent(interaction: ComponentInteraction): Promise<boolean> {
        this.pruneComponentActivity();
        const messageId = interaction.message.id;
        const lastActive = componentMessageActivity.get(messageId) || interaction.message.createdTimestamp || Date.now();

        if (Date.now() - lastActive <= COMPONENT_IDLE_TTL_MS) {
            componentMessageActivity.set(messageId, Date.now());
            this.scheduleComponentExpiry(interaction.message, true);
            return false;
        }
        componentMessageActivity.delete(messageId);
        componentMessages.delete(messageId);
        if (latestComponentMessageByChannel.get(interaction.message.channelId) === messageId) {
            latestComponentMessageByChannel.delete(interaction.message.channelId);
        }
        pendingLimitRetries.forEach((pending, id) => {
            if (pending.expiresAt < Date.now()) pendingLimitRetries.delete(id);
        });
        await interaction.reply({
            content: 'This interaction expired after 60 seconds of inactivity.',
            flags: MessageFlags.Ephemeral
        }).catch(() => undefined);
        await this.disableMessageComponents(interaction.message);

        return true;
    }

    private pruneComponentActivity(): void {
        const now = Date.now();

        for (const [messageId, lastActive] of componentMessageActivity) {
            if (now - lastActive > COMPONENT_IDLE_TTL_MS) {
                componentMessageActivity.delete(messageId);
                componentMessages.delete(messageId);
            }
        }
        this.pruneTransientSessions();
    }

    private pruneTransientSessions(): void {
        const now = Date.now();

        for (const [id, session] of responseCardSessions) {
            if (now - session.createdAt > COMPONENT_IDLE_TTL_MS) responseCardSessions.delete(id);
        }
        for (const [id, session] of fileExplorerSessions) {
            if (now - session.createdAt > COMPONENT_IDLE_TTL_MS) fileExplorerSessions.delete(id);
        }
        for (const [channelId, focus] of fileExplorerFocusByChannel) {
            if (now - focus.updatedAt > 30 * 60 * 1000) fileExplorerFocusByChannel.delete(channelId);
        }
    }

    private scheduleComponentExpiry(message: Message | null | undefined, hasComponents = true, replacePrevious = false): void {
        if (!message || !hasComponents) return;
        const previousId = latestComponentMessageByChannel.get(message.channelId);

        if (replacePrevious && previousId && previousId !== message.id) {
            const previous = componentMessages.get(previousId);

            if (previous) void this.disableMessageComponents(previous);
        }
        componentMessages.set(message.id, message);
        if (replacePrevious || !previousId) {
            latestComponentMessageByChannel.set(message.channelId, message.id);
        }
        componentMessageActivity.set(message.id, Date.now());
        setTimeout(() => {
            const lastActive = componentMessageActivity.get(message.id);

            if (!lastActive || Date.now() - lastActive < COMPONENT_IDLE_TTL_MS) return;
            componentMessageActivity.delete(message.id);
            componentMessages.delete(message.id);
            if (latestComponentMessageByChannel.get(message.channelId) === message.id) {
                latestComponentMessageByChannel.delete(message.channelId);
            }
            void this.disableMessageComponents(message);
        }, COMPONENT_IDLE_TTL_MS + 250);
    }

    private async disableMessageComponents(message: Message): Promise<void> {
        const components = message.components.map(row => {
            const json = row.toJSON() as any;

            return {
                ...json,
                components: (json.components || []).map((component: any) => ({
                    ...component,
                    disabled: true
                }))
            };
        });

        if (components.length === 0) return;
        await message.edit({ components }).catch(() => undefined);
    }

    private async resolveProject(workspace?: string, model?: string): Promise<{ workspace: string; model?: string | null }> {
        if (workspace) {
            const project = await findProject(workspace);

            if (project) return project;

            return { workspace, model };
        }
        const activeProject = await getActiveProject();

        return activeProject || { workspace: this.config.defaultWorkspace, model: model || this.config.defaultModel };
    }

    private async resolveNaturalProject(request: string): Promise<{ workspace: string; model?: string | null } | null> {
        const explicitWorkspace = request.match(/\bworkspace\s+((?:~|\/Users\/apple|\/tmp|\/var\/folders)\/[^\s`'"]+)/i)?.[1];
        const namedProject = request.match(/\b(?:use|switch to|work in|continue in|open)\s+(?:the\s+)?project\s+([a-zA-Z0-9_. -]{2,60}?)(?:\s+(?:to|and|for|with)\b|[?.!,;:]|$)/i)?.[1];
        const newProjectName = request.match(/\b(?:create|start|make|set up)\s+(?:a\s+)?new\s+project(?:\s+(?:called|named))?\s+([a-zA-Z0-9_. -]{2,60}?)(?:\s+(?:to|and|for|with)\b|[?.!,;:]|$)/i)?.[1];

        if (namedProject) {
            const project = await findProject(this.cleanProjectName(namedProject));

            if (project) {
                await setActiveProject(project.name);
                return project;
            }
        }

        if (explicitWorkspace) {
            const workspace = this.expandHomePath(explicitWorkspace);
            const name = this.cleanProjectName(newProjectName || namedProject || path.basename(workspace));

            await mkdir(workspace, { recursive: true });
            return saveProject({ name, workspace });
        }

        if (newProjectName) {
            const name = this.cleanProjectName(newProjectName);
            const workspace = path.join(os.homedir(), 'DiscodeProjects', this.slugProjectName(name));

            await mkdir(workspace, { recursive: true });
            return saveProject({ name, workspace });
        }

        return null;
    }

    private cleanProjectName(value: string): string {
        return value
            .replace(/[?.!,;:]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private slugProjectName(value: string): string {
        return this.cleanProjectName(value)
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 80) || 'project';
    }

    private expandHomePath(value: string): string {
        if (value === '~') return os.homedir();
        if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));

        return value;
    }

    private async createThread(channel: TextChannel, name: string): Promise<any> {
        return channel.threads.create({
            name: this.normalizeThreadName(name),
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour
        });
    }

    private normalizeThreadName(name: string): string {
        const normalized = name
            .replace(/https?:\/\/\S+/g, '')
            .replace(/<#\d+>/g, '')
            .replace(/<@!?\d+>/g, '')
            .replace(/[^\w\s.-]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return `${this.commandName}-${(normalized || 'chat').slice(0, 72)}`;
    }

    private isAgentThreadName(name: string): boolean {
        const normalized = name.toLowerCase();

        return normalized.startsWith(`${this.commandName}-`);
    }

    private cleanBotName(value: string): string {
        return value
            .replace(/[^\w\s.-]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 40) || 'Discode';
    }

    private cleanCommandName(value: string): string {
        const normalized = value
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32);

        return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : 'discode';
    }

    private getChatName(prompt: string): string {
        const hadContext = this.hasContextReference(prompt);
        const cleaned = prompt
            .replace(/```[\s\S]*?```/g, '')
            .replace(/Discord context:[\s\S]*$/i, '')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/<#\d+>/g, 'channel')
            .replace(/<@!?\d+>/g, '')
            .replace(/<@&\d+>/g, '')
            .replace(/<a?:\w+:\d+>/g, '')
            .replace(/[^\w\s.-]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const words = cleaned
            .split(' ')
            .filter(Boolean)
            .slice(0, 8)
            .join(' ');

        return words || (hadContext ? 'Review Discord context' : 'New chat');
    }

    private selectConversationName(existingName: string | undefined, requestedName: string | undefined, prompt: string): string {
        const promptName = this.getChatName(prompt);

        if (existingName && !this.isWeakChatName(existingName)) return existingName;
        if (requestedName && !this.isWeakChatName(requestedName)) return requestedName;

        return promptName;
    }

    private isWeakChatName(name: string): boolean {
        const normalized = name
            .replace(new RegExp(`^${this.escapeRegExp(this.commandName)}-`, 'i'), '')
            .replace(/https?:\/\/\S+/g, '')
            .replace(/[^\w\s.-]/g, '')
            .trim()
            .toLowerCase();

        return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(normalized)
            || normalized.length < 8
            || ['chat', 'new chat', 'yo', 'hi', 'hey', 'hello', 'start', 'morefeinn'].includes(normalized);
    }

    private async renameThreadIfUseful(target: ResponseTarget, name: string): Promise<void> {
        const channel = target.channel;

        if (!channel?.isThread()) return;
        const normalized = this.normalizeThreadName(name);

        if (channel.name === normalized) return;
        await channel.setName(normalized).catch(() => undefined);
    }

    private getAccountAlias(account: AccountSummary): string {
        const zeroIndex = Math.max(0, account.index - 1);
        const adjective = ACCOUNT_ADJECTIVES[zeroIndex % ACCOUNT_ADJECTIVES.length];
        const noun = ACCOUNT_NOUNS[Math.floor(zeroIndex / ACCOUNT_ADJECTIVES.length) % ACCOUNT_NOUNS.length];

        return `${adjective} ${noun} #${account.index}`;
    }

    private capitalize(value: string): string {
        if (!value) return value;

        return value.slice(0, 1).toUpperCase() + value.slice(1);
    }

    private async renderLoadedChat(chat: ConversationRecord, guildId?: string): Promise<string> {
        const link = `\n${this.createConversationLink(chat, guildId)}`;
        const transcript = await getTranscript(chat.codexThreadId, 4);
        const transcriptText = transcript.length > 0
            ? `\n\nRecent history:\n${transcript.map(item => `${item.role === 'user' ? 'User' : this.botName}: ${item.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}`
            : '';

        return `Loaded ${await this.getConversationDisplayName(chat)}.${link}${transcriptText}`;
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private getConversationName(chat: ConversationRecord): string {
        const name = chat.name ? this.getChatName(chat.name) : '';

        return name && !this.isWeakChatName(name) ? name : this.getChatName(chat.codexThreadId);
    }

    private async getConversationDisplayName(chat: ConversationRecord): Promise<string> {
        const stored = this.getConversationName(chat);

        if (!this.isWeakChatName(stored)) return stored;
        const transcript = await getTranscript(chat.codexThreadId, 8);
        const userMessage = transcript.find(item => item.role === 'user' && !this.isWeakChatName(this.getChatName(item.text)));

        if (userMessage) return this.getChatName(userMessage.text);

        return 'Saved chat';
    }

    private createConversationLink(chat: ConversationRecord, fallbackGuildId?: string): string {
        const guildId = chat.discordGuildId || fallbackGuildId;
        const channelId = chat.discordThreadId || chat.discordChannelId;
        const messageId = chat.latestMessageId;
        const base = guildId
            ? `https://discord.com/channels/${guildId}/${channelId}`
            : `https://discord.com/channels/@me/${channelId}`;

        return messageId ? `${base}/${messageId}` : base;
    }

    private filterChoices(query: string, choices: { name: string; value: string }[]): { name: string; value: string }[] {
        const normalized = query.toLowerCase();

        return choices
            .filter(choice => choice.name && choice.value)
            .filter(choice => choice.name.toLowerCase().includes(normalized) || choice.value.toLowerCase().includes(normalized))
            .slice(0, 25);
    }
}
