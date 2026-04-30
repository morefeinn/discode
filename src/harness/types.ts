import type { CodexEventHandler, CodexRunOptions, CodexUsage } from '../codex/runner.js';

export type NativeBackend = 'openai' | 'anthropic' | 'zai' | 'qwen' | 'groq' | 'custom';

export interface NativeHarnessResult {
    ok: boolean;
    text: string;
    error?: string;
    usage?: CodexUsage | null;
    model?: string;
}

export interface HarnessContext {
    backend: NativeBackend;
    model: string;
    env: Record<string, string>;
    workspace: string;
    toolsEnabled: boolean;
    depth: number;
    maxDepth: number;
    onEvent?: CodexEventHandler;
    signal?: AbortSignal;
    runSubagent: (prompt: string, options?: Partial<CodexRunOptions>) => Promise<NativeHarnessResult>;
}

export interface ProviderTurnResult {
    finalText?: string;
    messages: any[];
    toolCalls: HarnessToolCall[];
    usage?: CodexUsage | null;
}

export interface HarnessToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface HarnessToolResult {
    id: string;
    content: string;
}
