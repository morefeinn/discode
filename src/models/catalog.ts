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
        release_date?: string;
        last_updated?: string;
    }>;
}

const cachePath = path.resolve('data', 'models-dev-cache.json');
const cacheTtlMs = 24 * 60 * 60 * 1000;
const modelsUrl = process.env.DISCODE_MODELS_URL?.trim() || 'https://models.dev/api.json';

export async function listAvailableModels(provider: ProviderType, refresh = false): Promise<ModelChoiceMetadata[]> {
    const providers: Record<string, ModelsDevProvider> = await readModelsDev(refresh).catch(() => ({}));
    const providerIds = providerIdsFor(provider, providers);
    const values: ModelChoiceMetadata[] = [];

    for (const providerId of providerIds) {
        const providerData = providers[providerId];

        if (!providerData?.models) continue;
        for (const model of Object.values(providerData.models)) {
            const id = model.id?.trim();

            if (!id) continue;
            values.push({
                name: model.name || id,
                value: provider === 'opencode' ? `${providerId}/${id}` : id,
                provider: providerData.name || providerId,
                reasoning: model.reasoning === true,
                toolCall: model.tool_call === true
            });
        }
    }

    return (values.length > 0 ? values : fallbackModels(provider))
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
    if (provider === 'opencode') return Object.keys(providers);

    return ['openai'];
}

function score(model: ModelChoiceMetadata): number {
    const value = `${model.name} ${model.value}`.toLowerCase();
    let score = 0;

    if (model.reasoning) score += 100;
    if (model.toolCall) score += 50;
    if (value.includes('codex')) score += 40;
    if (value.includes('claude') || value.includes('gpt') || value.includes('qwen') || value.includes('glm')) score += 25;
    if (value.includes('latest') || value.includes('5') || value.includes('4.5')) score += 10;

    return score;
}

function fallbackModels(provider: ProviderType): ModelChoiceMetadata[] {
    const values: Record<ProviderType, string[]> = {
        codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
        opencode: ['openai/gpt-5.5', 'openai/gpt-5.4', 'anthropic/claude-sonnet-4-5', 'qwen/qwen3-coder-plus', 'z-ai/glm-4.6'],
        anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
        zai: ['glm-4.6', 'glm-4.5'],
        qwen: ['qwen3-coder-plus', 'qwen3-max', 'qwen3-plus'],
        custom: []
    };

    return (values[provider] || values.codex).map(value => ({
        name: value,
        value,
        provider: provider === 'custom' ? 'Custom' : provider,
        reasoning: /gpt-5|claude|glm|qwen3/i.test(value),
        toolCall: provider !== 'custom'
    }));
}
