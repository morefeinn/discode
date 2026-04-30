import type { AccountRouter } from '../accounts/router.js';
import type { AccountProvider } from '../accounts/router.js';
import type { CodexRunOptions } from '../codex/runner.js';
import {
    appendToolResults,
    initialMessages,
    mergeUsage,
    resolveModel,
    runProviderTurn,
    selectBackend
} from './providers.js';
import { HarnessTools } from './tools.js';
import type { HarnessContext, NativeHarnessResult } from './types.js';

const maxTurns = 8;
const defaultMaxDepth = 2;

export class HarnessRuntime {
    private readonly tools = new HarnessTools();

    constructor(
        private readonly accounts: AccountRouter,
        private readonly workspace: string,
        private readonly baseOptions: CodexRunOptions,
        private readonly depth = 0
    ) {}

    async run(prompt: string): Promise<NativeHarnessResult> {
        const providerScope = this.providerScope();
        const account = await this.accounts.getActiveAccount(providerScope);
        const env = {
            ...process.env,
            ...await this.accounts.getActiveEnvironment(providerScope)
        } as Record<string, string>;
        const backend = selectBackend(this.baseOptions.model, account?.provider, env);
        const model = await resolveModel(backend, this.baseOptions.model, env);

        if (!model) {
            return {
                ok: false,
                text: '',
                error: 'Native Discode harness needs a live model. Import credentials, then choose a model from settings or set DEFAULT_MODEL.',
                model: ''
            };
        }
        const context: HarnessContext = {
            backend,
            model,
            env,
            workspace: this.workspace,
            toolsEnabled: this.baseOptions.dangerous === true || this.baseOptions.permissionMode === 'full',
            reasoningEffort: this.baseOptions.reasoningEffort,
            depth: this.depth,
            maxDepth: defaultMaxDepth,
            onEvent: this.baseOptions.onEvent,
            signal: this.baseOptions.signal,
            runSubagent: (subPrompt, overrides = {}) => {
                const child = new HarnessRuntime(this.accounts, this.workspace, {
                    ...this.baseOptions,
                    ...overrides
                }, this.depth + 1);

                return child.run(subPrompt);
            }
        };
        const messages = initialMessages(context, prompt);
        let usage = null;

        try {
            const result = await this.runTurns(context, messages, usage);

            if (result) return result;

            return {
                ok: false,
                text: '',
                error: 'Native harness reached the tool-loop limit before the model returned a final answer.',
                usage,
                model: context.model
            };
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            const fallbackModel = isStaleModelError(text)
                ? await resolveModel(backend, null, env).catch(() => '')
                : '';

            if (fallbackModel && fallbackModel !== context.model) {
                await context.onEvent?.({ label: `Retrying native ${context.backend} with ${fallbackModel}` });
                const retryContext = { ...context, model: fallbackModel };
                const retryMessages = initialMessages(retryContext, prompt);

                try {
                    const retry = await this.runTurns(retryContext, retryMessages, usage);

                    if (retry) return retry;
                } catch (retryError) {
                    const retryText = retryError instanceof Error ? retryError.message : String(retryError);

                    return { ok: false, text: '', error: retryText, usage, model: fallbackModel };
                }
            }

            return { ok: false, text: '', error: text, usage, model: context.model };
        } finally {
            this.tools.close();
        }
    }

    private async runTurns(context: HarnessContext, messages: any[], usage: any): Promise<NativeHarnessResult | null> {
        for (let turn = 0; turn < maxTurns; turn += 1) {
            await context.onEvent?.({ label: turn === 0 ? 'Starting native Discode harness' : 'Continuing native tool loop' });
            const providerTools = context.backend === 'anthropic'
                ? this.tools.anthropicTools()
                : this.tools.openAiTools();
            const turnResult = await runProviderTurn(context, messages, providerTools);

            usage = mergeUsage(usage, turnResult.usage || null);
            messages.push(...turnResult.messages);
            if (turnResult.toolCalls.length === 0) {
                return {
                    ok: true,
                    text: turnResult.finalText || '',
                    usage,
                    model: context.model
                };
            }
            const toolResults = [];

            for (const call of turnResult.toolCalls) {
                toolResults.push({
                    id: call.id,
                    content: await this.tools.run(call.name, call.input, context)
                });
            }
            appendToolResults(context, messages, toolResults);
        }

        return null;
    }

    private providerScope(): AccountProvider | null {
        const provider = this.baseOptions.provider;

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
}

function isStaleModelError(value: string): boolean {
    return /model[_ -]?(?:decommissioned|deprecated)|decommissioned|deprecated|model_not_found|does not exist|not supported/i.test(value);
}
