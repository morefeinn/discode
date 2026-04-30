import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeConfig } from '../config.js';
import { getBridgeSettings, getEffectiveAutoSwitchOnLimit, getEffectiveProviderPriority, PermissionMode, ProviderType } from '../state/settings.js';
import { AccountProvider, AccountRouter } from '../accounts/router.js';
import { runNativeHarness } from '../harness/native.js';

export interface CodexRunOptions {
    prompt?: string;
    workspace?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    dangerous?: boolean;
    provider?: ProviderType;
    permissionMode?: PermissionMode;
    fresh?: boolean;
    codexThreadId?: string | null;
    imagePaths?: string[];
    onEvent?: CodexEventHandler;
    signal?: AbortSignal;
}

export interface CodexReviewOptions {
    workspace?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    dangerous?: boolean;
    permissionMode?: PermissionMode;
    scope: 'uncommitted' | 'base' | 'commit';
    ref?: string | null;
    instructions?: string | null;
    onEvent?: CodexEventHandler;
    requesterId?: string;
    signal?: AbortSignal;
}

export interface CodexRunResult {
    ok: boolean;
    text: string;
    threadId?: string | null;
    error?: string;
    provider?: ProviderType;
    missingExecutable?: string;
    installCommand?: string;
    installLabel?: string;
    switchedAccountName?: string;
    limitError?: string;
    limitAccountId?: string | null;
    limitAccountName?: string | null;
    usage?: CodexUsage | null;
    model?: string;
}

interface ProcessResult {
    code: number;
    stdout: string;
    stderr: string;
    threadId: string | null;
    usage: CodexUsage | null;
    missingExecutable?: string;
    installCommand?: string;
    installLabel?: string;
}

export interface CodexUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
}

export type CodexEventHandler = (event: { label: string; text?: string; threadId?: string; usage?: CodexUsage | null }) => void | Promise<void>;

export class CodexRunner {
    constructor(
        private readonly config: BridgeConfig,
        private readonly accounts: AccountRouter
    ) {}

    async runPrompt(options: CodexRunOptions): Promise<CodexRunResult> {
        const settings = await getBridgeSettings();
        const autoSwitchOnLimit = getEffectiveAutoSwitchOnLimit(settings, this.config.autoSwitchOnLimit);
        const run = () => this.runPromptOnce(options);
        const firstResult = await run();

        if (firstResult.ok || !autoSwitchOnLimit || !looksLikeLimit(firstResult.error || firstResult.text || '')) {
            return firstResult;
        }

        const provider = await this.getProvider(options.provider);
        const accountScope = this.getAccountScope(provider);
        const limitedAccount = await this.accounts.getActiveAccount(accountScope);
        const nextAccount = await this.accounts.switchToNext(accountScope);

        if (nextAccount && nextAccount.id !== limitedAccount?.id) {
            const retryResult = await run();

            if (retryResult.ok || !looksLikeLimit(retryResult.error || retryResult.text || '')) {
                retryResult.switchedAccountName = nextAccount.name;
                retryResult.limitError = firstResult.error || firstResult.text;
                retryResult.limitAccountId = limitedAccount?.id || null;
                retryResult.limitAccountName = limitedAccount?.name || null;

                return retryResult;
            }
        }

        const retryResult = await this.runPromptWithFallbackProvider(options, firstResult, settings);

        return retryResult;
    }

    async runReview(options: CodexReviewOptions): Promise<CodexRunResult> {
        const settings = await getBridgeSettings();
        const autoSwitchOnLimit = getEffectiveAutoSwitchOnLimit(settings, this.config.autoSwitchOnLimit);
        const run = () => this.runReviewOnce(options);
        const firstResult = await run();

        if (firstResult.ok || !autoSwitchOnLimit || !looksLikeLimit(firstResult.error || firstResult.text || '')) {
            return firstResult;
        }

        const limitedAccount = await this.accounts.getActiveAccount('codex');
        const nextAccount = await this.accounts.switchToNext('codex');

        if (!nextAccount) return firstResult;
        const retryResult = await run();
        retryResult.switchedAccountName = nextAccount.name;
        retryResult.limitError = firstResult.error || firstResult.text;
        retryResult.limitAccountId = limitedAccount?.id || null;
        retryResult.limitAccountName = limitedAccount?.name || null;

        return retryResult;
    }

    private async runPromptWithFallbackProvider(options: CodexRunOptions, firstResult: CodexRunResult, settings: Awaited<ReturnType<typeof getBridgeSettings>>): Promise<CodexRunResult> {
        const currentProvider = await this.getProvider(options.provider);
        const fallbackProviders = getEffectiveProviderPriority(settings, this.config.defaultProviderPriority)
            .filter(provider => provider !== currentProvider);

        for (const provider of fallbackProviders) {
            const retryResult = await this.runPromptOnce({
                ...options,
                provider
            });

            retryResult.limitError = firstResult.error || firstResult.text;
            if (retryResult.ok || !looksLikeLimit(retryResult.error || retryResult.text || '')) {
                retryResult.switchedAccountName = `${provider} fallback`;
                return retryResult;
            }
        }

        return firstResult;
    }

    async runRaw(argsText: string, workspace?: string): Promise<CodexRunResult> {
        const args = parseArgs(argsText);

        if (args.length === 0) {
            return { ok: false, text: '', error: 'No raw Codex arguments were provided.' };
        }

        const result = await this.spawnCodex(args, workspace || this.config.defaultWorkspace, null);
        const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

        return {
            ok: result.code === 0,
            text: text || `Codex exited with status ${result.code}.`,
            error: result.code === 0 ? undefined : text
        };
    }

    private async runPromptOnce(options: CodexRunOptions): Promise<CodexRunResult> {
        const provider = await this.getProvider(options.provider);

        if (this.isNativeProvider(provider)) return this.runNativePromptOnce({
            ...options,
            provider
        });
        if (provider !== 'codex') return this.runExternalPromptOnce(provider, options);

        const workspace = options.workspace || this.config.defaultWorkspace;
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-discord-'));
        const outputPath = path.join(tempDir, 'last-message.txt');
        const args = options.codexThreadId && !options.fresh
            ? this.getResumeArgs(options, outputPath)
            : this.getExecArgs(options, outputPath);

        try {
            const result = await this.spawnCodex(args, workspace, outputPath, options.onEvent, options.signal);
            const finalText = existsSync(outputPath) ? (await readFile(outputPath, 'utf8')).trim() : '';
            const threadId = result.threadId || extractThreadId(result.stdout);

            if (result.code === 0 && finalText) {
                return {
                    ok: true,
                    text: finalText,
                    threadId: threadId || options.codexThreadId || null,
                    usage: result.usage,
                    model: this.getSelectedModel(options.model),
                    provider
                };
            }

            return {
                ok: false,
                text: finalText,
                threadId: threadId || options.codexThreadId || null,
                usage: result.usage,
                model: this.getSelectedModel(options.model),
                provider,
                missingExecutable: result.missingExecutable,
                installCommand: result.installCommand,
                installLabel: result.installLabel,
                error: [finalText, extractJsonErrors(result.stdout), result.stderr]
                    .filter(Boolean)
                    .join('\n')
                    .slice(-4000) || `Codex exited with status ${result.code}.`
            };
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private async runReviewOnce(options: CodexReviewOptions): Promise<CodexRunResult> {
        const workspace = options.workspace || this.config.defaultWorkspace;
        const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-discord-review-'));
        const outputPath = path.join(tempDir, 'last-message.txt');
        const args = ['exec', 'review', '--json', '-o', outputPath];

        this.addModelArg(args, options.model);
        this.addReasoningArg(args, options.reasoningEffort);
        this.addAutoArgs(args, options.dangerous, options.permissionMode);

        if (options.scope === 'uncommitted') {
            args.push('--uncommitted');
        } else if (options.scope === 'base') {
            args.push('--base', options.ref || 'main');
        } else if (options.scope === 'commit') {
            if (!options.ref) throw new Error('Commit review requires a commit SHA.');
            args.push('--commit', options.ref);
        }

        if (options.instructions?.trim()) {
            args.push(options.instructions.trim());
        }

        try {
            const result = await this.spawnCodex(args, workspace, outputPath, options.onEvent, options.signal);
            const finalText = existsSync(outputPath) ? (await readFile(outputPath, 'utf8')).trim() : '';

            if (result.code === 0 && finalText) {
                return {
                    ok: true,
                    text: finalText,
                    usage: result.usage,
                    model: this.getSelectedModel(options.model),
                    provider: 'codex'
                };
            }

            return {
                ok: false,
                text: finalText,
                usage: result.usage,
                model: this.getSelectedModel(options.model),
                provider: 'codex',
                missingExecutable: result.missingExecutable,
                installCommand: result.installCommand,
                installLabel: result.installLabel,
                error: [finalText, extractJsonErrors(result.stdout), result.stderr]
                    .filter(Boolean)
                    .join('\n')
                    .slice(-4000) || `Codex review exited with status ${result.code}.`
            };
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    private getExecArgs(options: CodexRunOptions, outputPath: string): string[] {
        const args = ['exec', '--json', '-o', outputPath];

        this.addModelArg(args, options.model);
        this.addReasoningArg(args, options.reasoningEffort);
        this.addImageArgs(args, options.imagePaths);

        if (options.permissionMode === 'auto-review') {
            args.push('--sandbox', 'read-only');
        } else if (options.dangerous || options.permissionMode === 'full') {
            args.push('--dangerously-bypass-approvals-and-sandbox');
        } else {
            args.push('--sandbox', this.config.defaultSandbox);

            if (this.config.defaultSandbox !== 'read-only') {
                args.push('--full-auto');
            }
        }

        args.push(options.prompt || '');

        return args;
    }

    private getResumeArgs(options: CodexRunOptions, outputPath: string): string[] {
        const args = ['exec', 'resume', '--json', '-o', outputPath];

        this.addModelArg(args, options.model);
        this.addReasoningArg(args, options.reasoningEffort);
        this.addImageArgs(args, options.imagePaths);
        this.addAutoArgs(args, options.dangerous, options.permissionMode);
        args.push(options.codexThreadId || '', options.prompt || '');

        return args;
    }

    private addModelArg(args: string[], model: string | null | undefined): void {
        const selectedModel = this.getSelectedModel(model);

        if (selectedModel) args.push('-m', selectedModel);
    }

    private addReasoningArg(args: string[], reasoningEffort: string | null | undefined): void {
        if (!reasoningEffort || reasoningEffort === 'none') return;

        args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
    }

    private addImageArgs(args: string[], imagePaths: string[] | undefined): void {
        for (const imagePath of imagePaths || []) {
            args.push('-i', imagePath);
        }
    }

    private getSelectedModel(model: string | null | undefined): string {
        if (model) return model;

        if (this.config.defaultModel) return this.config.defaultModel;

        return '';
    }

    private addAutoArgs(args: string[], dangerous: boolean | undefined, permissionMode?: PermissionMode): void {
        if (permissionMode === 'auto-review') {
            args.push('--sandbox', 'read-only');
        } else if (dangerous || permissionMode === 'full') {
            args.push('--dangerously-bypass-approvals-and-sandbox');
        } else {
            args.push('--full-auto');
        }
    }

    private async spawnCodex(
        args: string[],
        workspace: string,
        outputPath: string | null,
        onEvent?: CodexEventHandler,
        signal?: AbortSignal
    ): Promise<ProcessResult> {
        let stdout = '';
        let stderr = '';
        let pendingStdout = '';
        let threadId: string | null = null;
        let usage: CodexUsage | null = null;

        const accountEnv = await this.accounts.getActiveEnvironment('codex');
        const code = await new Promise<number>(resolve => {
            const child = spawn(this.config.codexBin, args, {
                cwd: workspace,
                env: {
                    ...process.env,
                    ...accountEnv,
                    ...(this.config.extensionRobloxApiKey ? { ROBLOX_API_KEY: this.config.extensionRobloxApiKey } : {}),
                    ...(this.config.extensionRobloxUniverseId ? { ROBLOX_UNIVERSE_ID: this.config.extensionRobloxUniverseId } : {}),
                    ...(this.config.extensionRobloxPlaceId ? { ROBLOX_PLACE_ID: this.config.extensionRobloxPlaceId } : {}),
                    NO_COLOR: '1'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            const timeout = setTimeout(() => {
                child.kill('SIGTERM');
            }, this.config.runTimeoutMs);
            const abort = () => {
                stderr += '\nInterrupted by a newer request.';
                child.kill('SIGTERM');
            };

            if (signal?.aborted) abort();
            signal?.addEventListener('abort', abort, { once: true });

            child.stdout.on('data', chunk => {
                const text = String(chunk);
                stdout += text;
                pendingStdout += text;
                const lines = pendingStdout.split('\n');
                pendingStdout = lines.pop() || '';

                for (const line of lines) {
                    const parsed = parseCodexEvent(line);

                    if (!parsed) continue;

                    if (parsed.threadId) threadId = parsed.threadId;
                    if (parsed.usage) usage = parsed.usage;
                    if (parsed.label && onEvent) {
                        void onEvent({
                            label: parsed.label,
                            text: parsed.text,
                            threadId: parsed.threadId,
                            usage: parsed.usage
                        });
                    }
                }
            });
            child.stderr.on('data', chunk => {
                stderr += String(chunk);
            });
            child.on('error', error => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
                const missing = missingExecutableError(error, this.config.codexBin);

                if (missing) {
                    stderr += formatMissingExecutableMessage('codex', this.config.codexBin);
                } else {
                    stderr += String(error);
                }
                resolve(1);
            });
            child.on('close', exitCode => {
                clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
                resolve(exitCode ?? 1);
            });
        });

        if (outputPath && code !== 0 && existsSync(outputPath)) {
            stdout += `\n${await readFile(outputPath, 'utf8').catch(() => '')}`;
        }

        const missingExecutable = executableMissingFromText(stderr, this.config.codexBin) ? this.config.codexBin : undefined;
        const install = missingExecutable ? providerInstall('codex') : null;

        return {
            code,
            stdout,
            stderr,
            threadId,
            usage,
            missingExecutable,
            installCommand: install?.command,
            installLabel: install?.label
        };
    }

    private async runExternalPromptOnce(provider: ProviderType, options: CodexRunOptions): Promise<CodexRunResult> {
        const workspace = options.workspace || this.config.defaultWorkspace;
        const result = await this.spawnExternalProvider(provider, workspace, options);
        const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

        return {
            ok: result.code === 0,
            text: text || `${provider} exited with status ${result.code}.`,
            error: result.code === 0 ? undefined : text,
            provider,
            missingExecutable: result.missingExecutable,
            installCommand: result.installCommand,
            installLabel: result.installLabel,
            usage: result.usage,
            model: options.model || provider
        };
    }

    private async runNativePromptOnce(options: CodexRunOptions): Promise<CodexRunResult> {
        const workspace = options.workspace || this.config.defaultWorkspace;
        const result = await runNativeHarness(this.accounts, options, workspace);

        return {
            ok: result.ok,
            text: result.text || result.error || '',
            error: result.ok ? undefined : result.error || result.text,
            provider: 'discode',
            usage: result.usage,
            model: result.model
        };
    }

    private async spawnExternalProvider(provider: ProviderType, workspace: string, options: CodexRunOptions): Promise<ProcessResult> {
        let stdout = '';
        let stderr = '';
        const accountEnv = await this.accounts.getActiveEnvironment(this.getAccountScope(provider));
        const command = await this.getProviderCommand(provider, options);
        const code = await new Promise<number>(resolve => {
            let child;

            try {
                child = spawn(command.bin, command.args, {
                    cwd: workspace,
                    env: {
                        ...process.env,
                        ...accountEnv,
                        ...(this.config.extensionRobloxApiKey ? { ROBLOX_API_KEY: this.config.extensionRobloxApiKey } : {}),
                        ...(this.config.extensionRobloxUniverseId ? { ROBLOX_UNIVERSE_ID: this.config.extensionRobloxUniverseId } : {}),
                        ...(this.config.extensionRobloxPlaceId ? { ROBLOX_PLACE_ID: this.config.extensionRobloxPlaceId } : {}),
                        DISCODE_PROMPT: options.prompt || '',
                        DISCODE_WORKSPACE: workspace,
                        DISCODE_MODEL: options.model || '',
                        DISCODE_REASONING: options.reasoningEffort || '',
                        DISCODE_PERMISSION_MODE: options.permissionMode || '',
                        NO_COLOR: '1'
                    },
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (error) {
                stderr += formatSpawnError(provider, command.bin, error);
                resolve(1);
                return;
            }
            const timeout = setTimeout(() => {
                child.kill('SIGTERM');
            }, this.config.runTimeoutMs);
            const abort = () => {
                stderr += '\nInterrupted by a newer request.';
                child.kill('SIGTERM');
            };

            if (options.signal?.aborted) abort();
            options.signal?.addEventListener('abort', abort, { once: true });

            child.stdout.on('data', chunk => {
                stdout += String(chunk);
            });
            child.stderr.on('data', chunk => {
                stderr += String(chunk);
            });
            child.on('error', error => {
                clearTimeout(timeout);
                options.signal?.removeEventListener('abort', abort);
                stderr += formatSpawnError(provider, command.bin, error);
                resolve(1);
            });
            child.on('close', exitCode => {
                clearTimeout(timeout);
                options.signal?.removeEventListener('abort', abort);
                resolve(exitCode ?? 1);
            });
            child.stdin.end(options.prompt || '');
        });

        const missingExecutable = executableMissingFromText(stderr, command.bin) ? command.bin : undefined;
        const install = missingExecutable ? providerInstall(provider) : null;

        return {
            code,
            stdout,
            stderr,
            threadId: null,
            usage: null,
            missingExecutable,
            installCommand: install?.command,
            installLabel: install?.label
        };
    }

    private async getProvider(provider: ProviderType | undefined): Promise<ProviderType> {
        if (this.isProviderType(provider)) return provider;
        if (this.isProviderType(this.config.defaultProvider)) return this.config.defaultProvider;
        const accountProvider = await this.accounts.getActiveProvider();

        if (this.isAccountProvider(accountProvider)) {
            return accountProvider;
        }

        return 'discode';
    }

    private async getProviderCommand(provider: ProviderType, options: CodexRunOptions): Promise<{ bin: string; args: string[] }> {
        const accountCommand = await this.accounts.getActiveCommand(this.getAccountScope(provider));
        const customCommand = accountCommand || this.config.providerCommand;

        if (provider === 'custom' && customCommand) {
            const expanded = customCommand
                .replaceAll('{prompt}', options.prompt || '')
                .replaceAll('{model}', options.model || '')
                .replaceAll('{reasoning}', options.reasoningEffort || '')
                .replaceAll('{permission}', options.permissionMode || '');
            const args = parseArgs(expanded);

            if (args.length > 0) return { bin: args[0], args: args.slice(1) };
        }

        if (provider === 'opencode') {
            const args = ['run'];

            if (options.model) args.push('--model', options.model);
            args.push(options.prompt || '');

            return { bin: this.config.opencodeBin, args };
        }

        if (provider === 'anthropic') {
            return { bin: this.config.anthropicBin, args: ['-p', options.prompt || ''] };
        }

        if (provider === 'zai') {
            return { bin: this.config.zaiBin, args: ['-p', options.prompt || ''] };
        }

        if (provider === 'qwen') {
            return { bin: this.config.qwenBin, args: ['-p', options.prompt || ''] };
        }

        return { bin: 'sh', args: ['-lc', 'printf "%s\\n" "DISCODE_PROVIDER_COMMAND is required for the custom provider." >&2; exit 1'] };
    }

    private isAccountProvider(provider: AccountProvider | null): provider is AccountProvider {
        return provider === 'codex'
            || provider === 'opencode'
            || provider === 'anthropic'
            || provider === 'zai'
            || provider === 'qwen'
            || provider === 'groq'
            || provider === 'custom';
    }

    private isProviderType(provider: string | undefined): provider is ProviderType {
        return provider === 'discode'
            || provider === 'codex'
            || provider === 'opencode'
            || provider === 'anthropic'
            || provider === 'zai'
            || provider === 'qwen'
            || provider === 'groq'
            || provider === 'custom';
    }

    private getAccountScope(provider: ProviderType): AccountProvider | null {
        if (provider === 'codex'
            || provider === 'opencode'
            || provider === 'anthropic'
            || provider === 'zai'
            || provider === 'qwen'
            || provider === 'groq'
            || provider === 'custom') {
            return provider;
        }

        return null;
    }

    private isNativeProvider(provider: ProviderType): boolean {
        return provider === 'discode'
            || provider === 'groq';
    }
}

function parseCodexEvent(line: string): { label?: string; text?: string; threadId?: string; usage?: CodexUsage | null } | null {
    try {
        const event = JSON.parse(line) as {
            type?: string;
            thread_id?: string;
            item?: { type?: string; text?: string; command?: string; status?: string };
            usage?: CodexUsage;
            message?: string;
            error?: { message?: string };
        };

        if (event.type === 'thread.started' && event.thread_id) {
            return { label: 'Opening the agent thread', threadId: event.thread_id };
        }

        if (event.type === 'turn.started') {
            return { label: 'Thinking through the request' };
        }

        if (event.item?.type === 'agent_message' && (event.type === 'item.started' || event.type === 'item.completed')) {
            return { label: 'Thinking through the response' };
        }

        if (event.item?.type === 'command_execution' && (event.type === 'item.started' || event.type === 'item.completed')) {
            const activity = describeCommandActivity(event.item.command || '');

            return {
                label: event.type === 'item.completed' ? activity.doneLabel : activity.label,
                text: activity.text
            };
        }

        if (event.type === 'turn.completed') {
            return { label: 'Finishing up', usage: normalizeUsage(event.usage) };
        }

        if (event.type === 'error' && event.message) {
            return { label: 'Error', text: event.message };
        }

        if (event.type === 'turn.failed' && event.error?.message) {
            return { label: 'Failed', text: event.error.message };
        }
    } catch {
    }

    return null;
}

function describeCommandActivity(command: string): { label: string; doneLabel: string; text?: string } {
    const normalized = command.replace(/\s+/g, ' ').trim();
    const shortCommand = normalized.length > 110 ? `${normalized.slice(0, 107).trimEnd()}...` : normalized;
    const executable = normalized.match(/^([\w./:-]+)/)?.[1]?.split('/').pop()?.toLowerCase() || '';

    if (['rg', 'grep', 'find', 'fd', 'ls', 'tree', 'sed', 'cat', 'head', 'tail', 'wc', 'pwd'].includes(executable)) {
        return { label: 'Inspecting project files', doneLabel: 'Finished inspecting files', text: shortCommand };
    }

    if (executable === 'git') {
        if (/\b(?:push|commit|add|tag|merge|rebase|cherry-pick)\b/.test(normalized)) {
            return { label: 'Updating git state', doneLabel: 'Updated git state', text: shortCommand };
        }

        return { label: 'Checking git state', doneLabel: 'Finished checking git', text: shortCommand };
    }

    if (['bun', 'npm', 'pnpm', 'yarn', 'node', 'tsc', 'cargo', 'go', 'python', 'python3', 'pytest', 'stylua'].includes(executable)) {
        return { label: 'Running project checks', doneLabel: 'Finished project checks', text: shortCommand };
    }

    if (['mkdir', 'cp', 'mv', 'rm', 'chmod', 'touch'].includes(executable)) {
        return { label: 'Updating local files', doneLabel: 'Finished updating files', text: shortCommand };
    }

    if (!shortCommand) {
        return { label: 'Using a tool', doneLabel: 'Finished using a tool' };
    }

    return { label: 'Running a tool command', doneLabel: 'Finished tool command', text: shortCommand };
}

function normalizeUsage(usage: CodexUsage | undefined): CodexUsage | null {
    if (!usage) return null;
    const inputTokens = usage.inputTokens ?? (usage as any).input_tokens;
    const cachedInputTokens = usage.cachedInputTokens ?? (usage as any).cached_input_tokens;
    const outputTokens = usage.outputTokens ?? (usage as any).output_tokens;
    const reasoningOutputTokens = usage.reasoningOutputTokens ?? (usage as any).reasoning_output_tokens;
    const billableInputTokens = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0));

    return {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens: billableInputTokens + (outputTokens || 0) + (reasoningOutputTokens || 0)
    };
}

function extractThreadId(stdout: string): string | null {
    for (const line of stdout.split('\n')) {
        try {
            const event = JSON.parse(line) as { type?: string; thread_id?: string };

            if (event.type === 'thread.started' && event.thread_id) return event.thread_id;
        } catch {
        }
    }

    return null;
}

function extractJsonErrors(stdout: string): string {
    const errors: string[] = [];

    for (const line of stdout.split('\n')) {
        try {
            const event = JSON.parse(line) as { type?: string; message?: string; error?: { message?: string } };

            if (event.type === 'error' && event.message) errors.push(event.message);
            if (event.type === 'turn.failed' && event.error?.message) errors.push(event.error.message);
        } catch {
        }
    }

    return errors.join('\n');
}

function looksLikeLimit(text: string): boolean {
    return /usage limit|rate limit|quota|too many requests|429|try again at|weekly limit|5.?hour|credit limit|insufficient credits/i.test(text);
}

function missingExecutableError(error: unknown, bin: string): boolean {
    const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : null;

    return code === 'ENOENT' || code === 'ENOEXEC' || executableMissingFromText(String(error), bin);
}

function executableMissingFromText(text: string, bin: string): boolean {
    const executable = bin.split(/[\\/]/).pop() || bin;
    const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    return new RegExp(`\\bENOENT\\b|not found.*${escaped}|${escaped}.*not found|executable not found`, 'i').test(text);
}

function formatSpawnError(provider: ProviderType, bin: string, error: unknown): string {
    return missingExecutableError(error, bin) ? formatMissingExecutableMessage(provider, bin) : String(error);
}

function formatMissingExecutableMessage(provider: ProviderType, bin: string): string {
    return `${providerLabel(provider, bin)} is not installed or is not on this bot process PATH.`;
}

function providerInstall(provider: ProviderType): { command: string; label: string } | null {
    if (provider === 'discode') return null;
    if (provider === 'groq') return null;
    if (provider === 'codex') return { command: 'bun add -g @openai/codex', label: 'Install Codex CLI' };
    if (provider === 'opencode') return { command: 'bun add -g opencode-ai', label: 'Install OpenCode CLI' };
    if (provider === 'anthropic') return { command: 'bun add -g @anthropic-ai/claude-code', label: 'Install Claude Code' };
    if (provider === 'zai') return { command: 'bun add -g @guizmo-ai/zai-cli', label: 'Install Z.ai CLI' };
    if (provider === 'qwen') return { command: 'bun add -g @qwen-code/qwen-code', label: 'Install Qwen Code' };

    return null;
}

function providerLabel(provider: ProviderType, bin: string): string {
    if (provider === 'discode') return 'Discode native harness';
    if (provider === 'codex') return 'Codex';
    if (provider === 'opencode') return 'Opencode';
    if (provider === 'anthropic') return 'Claude';
    if (provider === 'zai') return 'Z.ai';
    if (provider === 'qwen') return 'Qwen';
    if (provider === 'groq') return 'Groq';

    return bin.split(/[\\/]/).pop() || 'Provider';
}

function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (const char of input) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) args.push(current);

    return args;
}
