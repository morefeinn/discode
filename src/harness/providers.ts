import type { AccountProvider } from '../accounts/router.js';
import { listAvailableModels } from '../models/catalog.js';
import type { ProviderType } from '../state/settings.js';
import type { CodexUsage } from '../codex/runner.js';
import type { HarnessContext, HarnessToolCall, NativeBackend, ProviderTurnResult } from './types.js';

export async function runProviderTurn(context: HarnessContext, messages: any[], tools: any[]): Promise<ProviderTurnResult> {
    if (context.backend === 'anthropic') return await runAnthropicTurn(context, messages, tools);

    return await runOpenAiTurn(context, messages, tools);
}

export async function resolveModel(backend: NativeBackend, requested: string | null | undefined, env: Record<string, string>): Promise<string> {
    const direct = stripProviderPrefix(requested || '');

    if (direct) return direct;
    const provider = backendToProviderType(backend);
    const models = await listAvailableModels(provider, false, env).catch(() => []);
    const model = models.find(item => item.value !== '__default__')?.value || '';

    return stripProviderPrefix(model);
}

export function selectBackend(model: string | null | undefined, accountProvider: AccountProvider | undefined, env: Record<string, string>): NativeBackend {
    const prefix = (model || '').split('/')[0]?.toLowerCase();

    if (prefix === 'anthropic') return 'anthropic';
    if (prefix === 'z-ai' || prefix === 'zai') return 'zai';
    if (prefix === 'qwen' || prefix === 'alibaba') return 'qwen';
    if (accountProvider === 'anthropic') return 'anthropic';
    if (accountProvider === 'zai') return 'zai';
    if (accountProvider === 'qwen') return 'qwen';
    if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) return 'anthropic';
    if (env.ZAI_API_KEY && !env.OPENAI_API_KEY) return 'zai';
    if ((env.QWEN_API_KEY || env.DASHSCOPE_API_KEY) && !env.OPENAI_API_KEY) return 'qwen';

    return env.OPENAI_BASE_URL ? 'custom' : 'openai';
}

export function backendToProviderType(backend: NativeBackend): ProviderType {
    if (backend === 'anthropic') return 'anthropic';
    if (backend === 'zai') return 'zai';
    if (backend === 'qwen') return 'qwen';
    if (backend === 'custom') return 'custom';

    return 'codex';
}

function runOpenAiTurn(context: HarnessContext, messages: any[], tools: any[]): Promise<ProviderTurnResult> {
    return fetch(`${trimSlash(openAiBaseUrl(context))}/chat/completions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${apiKey(context)}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: context.model,
            messages,
            tools: context.toolsEnabled ? tools : undefined,
            tool_choice: context.toolsEnabled ? 'auto' : undefined
        }),
        signal: context.signal
    }).then(async response => {
        if (!response.ok) throw new Error(await responseError(response, context.backend));
        const parsed = await response.json() as any;
        const message = parsed.choices?.[0]?.message;

        if (!message) throw new Error('Provider returned no message.');

        return {
            messages: [message],
            finalText: Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? undefined : stringValue(message.content).trim(),
            toolCalls: normalizeOpenAiToolCalls(message.tool_calls),
            usage: normalizeOpenAiUsage(parsed.usage)
        };
    });
}

async function runAnthropicTurn(context: HarnessContext, messages: any[], tools: any[]): Promise<ProviderTurnResult> {
    const response = await fetch(`${trimSlash(context.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')}/v1/messages`, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey(context),
            'anthropic-version': context.env.ANTHROPIC_VERSION || '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: context.model,
            max_tokens: 4096,
            system: systemPrompt(context),
            messages,
            tools: context.toolsEnabled ? tools : undefined
        }),
        signal: context.signal
    });

    if (!response.ok) throw new Error(await responseError(response, context.backend));
    const parsed = await response.json() as any;
    const content = Array.isArray(parsed.content) ? parsed.content : [];
    const text = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
        .trim();
    const toolCalls = content
        .filter((block: any) => block?.type === 'tool_use')
        .map((block: any): HarnessToolCall => ({
            id: block.id,
            name: block.name,
            input: block.input || {}
        }));

    return {
        messages: [{ role: 'assistant', content }],
        finalText: toolCalls.length === 0 ? text : undefined,
        toolCalls,
        usage: normalizeAnthropicUsage(parsed.usage)
    };
}

export function initialMessages(context: HarnessContext, prompt: string): any[] {
    if (context.backend === 'anthropic') return [{ role: 'user', content: prompt }];

    return [
        { role: 'system', content: systemPrompt(context) },
        { role: 'user', content: prompt }
    ];
}

export function appendToolResults(context: HarnessContext, messages: any[], toolResults: { id: string; content: string }[]): void {
    if (context.backend === 'anthropic') {
        messages.push({
            role: 'user',
            content: toolResults.map(result => ({
                type: 'tool_result',
                tool_use_id: result.id,
                content: result.content
            }))
        });
        return;
    }

    for (const result of toolResults) {
        messages.push({
            role: 'tool',
            tool_call_id: result.id,
            content: result.content
        });
    }
}

export function systemPrompt(context: HarnessContext): string {
    const toolText = context.toolsEnabled
        ? 'You may use native tools: execute_shell, spawn_subagent, socket_open, socket_write, socket_close, process_start, process_write, process_read, and process_stop.'
        : 'No native tools are available in this permission mode. Answer without running commands.';

    return [
        'You are Discode native harness, a local coding agent controlled from Discord.',
        `Workspace: ${context.workspace}`,
        `Subagent recursion depth: ${context.depth}/${context.maxDepth}`,
        toolText,
        'Keep responses concise and mention verification performed when it matters.'
    ].join('\n');
}

export function mergeUsage(left: CodexUsage | null, right: CodexUsage | null): CodexUsage | null {
    if (!left) return right;
    if (!right) return left;

    return {
        inputTokens: (left.inputTokens || 0) + (right.inputTokens || 0),
        cachedInputTokens: (left.cachedInputTokens || 0) + (right.cachedInputTokens || 0),
        outputTokens: (left.outputTokens || 0) + (right.outputTokens || 0),
        reasoningOutputTokens: (left.reasoningOutputTokens || 0) + (right.reasoningOutputTokens || 0),
        totalTokens: (left.totalTokens || 0) + (right.totalTokens || 0)
    };
}

function normalizeOpenAiToolCalls(value: any): HarnessToolCall[] {
    if (!Array.isArray(value)) return [];

    return value.map((call: any) => ({
        id: call.id,
        name: call.function?.name || '',
        input: parseJsonObject(call.function?.arguments)
    })).filter(call => call.id && call.name);
}

function normalizeOpenAiUsage(usage: any): CodexUsage | null {
    if (!usage) return null;

    return {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens
    };
}

function normalizeAnthropicUsage(usage: any): CodexUsage | null {
    if (!usage) return null;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;

    return {
        inputTokens,
        outputTokens,
        totalTokens: (inputTokens || 0) + (outputTokens || 0)
    };
}

function openAiBaseUrl(context: HarnessContext): string {
    if (context.backend === 'zai') return context.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4';
    if (context.backend === 'qwen') return context.env.QWEN_BASE_URL || context.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

    return context.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
}

function apiKey(context: HarnessContext): string {
    const key = context.backend === 'anthropic'
        ? context.env.ANTHROPIC_API_KEY
        : context.backend === 'zai'
            ? context.env.ZAI_API_KEY
            : context.backend === 'qwen'
                ? context.env.QWEN_API_KEY || context.env.DASHSCOPE_API_KEY
                : context.env.OPENAI_API_KEY;

    if (!key) throw new Error(`Missing API key for native ${context.backend} harness.`);

    return key;
}

function stripProviderPrefix(value: string): string {
    const normalized = value.trim();

    if (!normalized) return '';
    const [prefix, ...rest] = normalized.split('/');

    if (rest.length > 0 && ['openai', 'anthropic', 'z-ai', 'zai', 'qwen', 'alibaba', 'custom'].includes(prefix.toLowerCase())) {
        return rest.join('/');
    }

    return normalized;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string' || !value.trim()) return {};

    try {
        const parsed = JSON.parse(value);

        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function responseError(response: Response, backend: NativeBackend): Promise<string> {
    const text = await response.text().catch(() => '');

    return `Native ${backend} request failed with HTTP ${response.status}.${text ? `\n${text.slice(-1000)}` : ''}`;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/g, '');
}
