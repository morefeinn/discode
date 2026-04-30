import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ProviderType } from '../state/settings.js';

export interface ModelChoiceMetadata {
    name: string;
    value: string;
    provider: string;
    reasoning: boolean;
    toolCall: boolean;
}

interface ModelsDevProvider {
    id?: string;
    name?: string;
    models?: Record<string, {
        id?: string;
        name?: string;
        reasoning?: boolean;
        tool_call?: boolean;
        status?: string;
        active?: boolean;
        release_date?: string;
        last_updated?: string;
        modalities?: {
            input?: string[];
            output?: string[];
        };
    }>;
}

type ModelEnv = Record<string, string | undefined>;

const cachePath = path.resolve('data', 'models-dev-cache.json');
const cacheTtlMs = 24 * 60 * 60 * 1000;
const modelsUrl = process.env.DISCODE_MODELS_URL?.trim() || 'https://models.dev/api.json';

export async function listAvailableModels(provider: ProviderType, refresh = false, env: ModelEnv = process.env): Promise<ModelChoiceMetadata[]> {
    const liveModels = await readProviderApiModels(provider, env).catch(() => []);

    if (liveModels.length > 0) {
        return uniqueModels(liveModels)
            .sort((left, right) => score(right) - score(left) || left.name.localeCompare(right.name));
    }
    const providers: Record<string, ModelsDevProvider> = await readModelsDev(refresh).catch(() => ({}));
    const providerIds = providerIdsFor(provider, providers);
    const values: ModelChoiceMetadata[] = [...liveModels];

    for (const providerId of providerIds) {
        const providerData = providers[providerId];

        if (!providerData?.models) continue;
        for (const model of Object.values(providerData.models)) {
            const id = model.id?.trim();

            if (!id) continue;
            if (!isSupportedCatalogModel(model)) continue;
            values.push({
                name: model.name || id,
                value: provider === 'opencode' || provider === 'discode' ? `${providerId}/${id}` : id,
                provider: providerData.name || providerId,
                reasoning: model.reasoning === true,
                toolCall: model.tool_call === true
            });
        }
    }

    return uniqueModels(values)
        .sort((left, right) => score(right) - score(left) || left.name.localeCompare(right.name));
}

async function readModelsDev(refresh: boolean): Promise<Record<string, ModelsDevProvider>> {
    if (!refresh && existsSync(cachePath)) {
        const cached = JSON.parse(await readFile(cachePath, 'utf8'));
        const fetchedAt = Date.parse(cached.fetchedAt || '');

        if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < cacheTtlMs) {
            return cached.providers || {};
        }
    }

    const response = await fetch(modelsUrl);

    if (!response.ok) {
        if (existsSync(cachePath)) {
            const cached = JSON.parse(await readFile(cachePath, 'utf8'));

            return cached.providers || {};
        }
        throw new Error(`Could not fetch model catalog: HTTP ${response.status}`);
    }

    const providers = await response.json() as Record<string, ModelsDevProvider>;

    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), providers }, null, 2) + '\n');

    return providers;
}

function providerIdsFor(provider: ProviderType, providers: Record<string, ModelsDevProvider>): string[] {
    if (provider === 'anthropic') return ['anthropic'];
    if (provider === 'zai') return ['z-ai', 'zai'].filter(id => providers[id]);
    if (provider === 'qwen') return ['alibaba', 'qwen'].filter(id => providers[id]);
    if (provider === 'groq') return ['groq'].filter(id => providers[id]);
    if (provider === 'opencode') return Object.keys(providers);
    if (provider === 'discode') return ['openai'].filter(id => providers[id]);

    return ['openai'];
}

function score(model: ModelChoiceMetadata): number {
    const value = `${model.name} ${model.value}`.toLowerCase();
    let score = 0;

    if (model.reasoning) score += 100;
    if (model.toolCall) score += 50;
    if (value.includes('codex')) score += 40;
    if (value.includes('gpt-oss-120b')) score += 80;
    if (value.includes('gpt-oss')) score += 70;
    if (value.includes('claude') || value.includes('gpt') || value.includes('qwen') || value.includes('glm')) score += 25;
    if (value.includes('latest') || value.includes('5') || value.includes('4.5')) score += 10;

    return score;
}

function uniqueModels(models: ModelChoiceMetadata[]): ModelChoiceMetadata[] {
    const seen = new Set<string>();

    return models.filter(model => {
        const value = model.value.trim();
        const key = canonicalModelKey(value);

        if (!value || seen.has(key)) return false;
        seen.add(key);
        model.value = value.slice(0, 100);
        model.name = (model.name || value).slice(0, 100);

        return true;
    });
}

async function readProviderApiModels(provider: ProviderType, env: ModelEnv): Promise<ModelChoiceMetadata[]> {
    const request = providerModelRequest(provider, env);

    if (!request) return [];
    const response = await fetch(request.url, { headers: request.headers });

    if (!response.ok) throw new Error(`Could not fetch ${provider} models: HTTP ${response.status}`);
    const parsed = await response.json() as any;
    const data = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];

    return data
        .map((model: any) => {
            const id = stringValue(model?.id) || stringValue(model?.model) || stringValue(model?.name);

            if (!id) return null;
            if (model?.active === false) return null;
            if (!isLikelyChatModel(id)) return null;

            return {
                name: stringValue(model?.display_name) || stringValue(model?.name) || id,
                value: provider === 'opencode' && !id.includes('/') ? `${request.providerId}/${id}` : id,
                provider: request.label,
                reasoning: /reason|thinking|gpt-[5-9]|claude|glm|qwen3/i.test(`${id} ${model?.name || ''}`),
                toolCall: true
            } satisfies ModelChoiceMetadata;
        })
        .filter(Boolean) as ModelChoiceMetadata[];
}

function isSupportedCatalogModel(model: {
    id?: string;
    name?: string;
    status?: string;
    active?: boolean;
    modalities?: { input?: string[]; output?: string[] };
}): boolean {
    if (model.active === false) return false;
    if (/decommission|deprecat|retired|sunset/i.test(model.status || '')) return false;
    if (!isLikelyChatModel(`${model.id || ''} ${model.name || ''}`)) return false;

    const input = model.modalities?.input;
    const output = model.modalities?.output;

    if (Array.isArray(input) && input.length > 0 && !input.includes('text')) return false;
    if (Array.isArray(output) && output.length > 0 && !output.includes('text')) return false;

    return true;
}

function isLikelyChatModel(value: string): boolean {
    return !/\b(?:whisper|orpheus|tts|transcription|speech|audio)\b/i.test(value);
}

function canonicalModelKey(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^(?:codex|openai|anthropic|zai|z-ai|qwen|alibaba|groq|custom):/, '');
}

function providerModelRequest(provider: ProviderType, env: ModelEnv): { url: string; providerId: string; label: string; headers: Record<string, string> } | null {
    if (provider === 'anthropic') {
        const key = env.ANTHROPIC_API_KEY?.trim();

        if (!key) return null;
        return {
            url: `${trimSlash(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com')}/v1/models`,
            providerId: 'anthropic',
            label: 'Anthropic',
            headers: {
                'x-api-key': key,
                'anthropic-version': env.ANTHROPIC_VERSION || '2023-06-01'
            }
        };
    }

    const openAiStyle = openAiStyleRequest(provider, env);

    return openAiStyle;
}

function openAiStyleRequest(provider: ProviderType, env: ModelEnv): { url: string; providerId: string; label: string; headers: Record<string, string> } | null {
    const values: Record<ProviderType, { key?: string; base?: string; providerId: string; label: string }> = {
        discode: {
            key: env.OPENAI_API_KEY,
            base: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            providerId: 'openai',
            label: 'OpenAI'
        },
        codex: {
            key: env.OPENAI_API_KEY,
            base: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            providerId: 'openai',
            label: 'OpenAI'
        },
        opencode: {
            key: env.OPENAI_API_KEY,
            base: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            providerId: 'openai',
            label: 'OpenAI'
        },
        zai: {
            key: env.ZAI_API_KEY,
            base: env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4',
            providerId: 'z-ai',
            label: 'Z.ai'
        },
        qwen: {
            key: env.QWEN_API_KEY || env.DASHSCOPE_API_KEY,
            base: env.QWEN_BASE_URL || env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            providerId: 'qwen',
            label: 'Qwen'
        },
        groq: {
            key: env.GROQ_API_KEY,
            base: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
            providerId: 'groq',
            label: 'Groq'
        },
        anthropic: {
            providerId: 'anthropic',
            label: 'Anthropic'
        },
        custom: {
            key: env.OPENAI_API_KEY,
            base: env.OPENAI_BASE_URL,
            providerId: 'custom',
            label: 'Custom'
        }
    };
    const value = values[provider];
    const key = value.key?.trim();
    const base = value.base?.trim();

    if (!key || !base) return null;

    return {
        url: `${trimSlash(base)}/models`,
        providerId: value.providerId,
        label: value.label,
        headers: { authorization: `Bearer ${key}` }
    };
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function trimSlash(value: string): string {
    return value.replace(/\/+$/g, '');
}
