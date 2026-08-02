/**
 * tests/pickerGroups.test.ts
 *
 * Tier-grouped picker data (mockup-model-cost-tiers W2b, chosen 2026-07-30):
 * cost tier is the grouping axis — free models of every KEYED provider in
 * one group, paid-only models in a second, the local group always last.
 */

import { describe, it, expect } from 'vitest';
import { buildPickerGroups } from '../chat/pickerGroups';
import type { Registry, Settings } from '../types';

const registry = {
  asOf: '2026-07-30',
  providers: {
    gemini: {
      label: 'Gemini', kind: 'cloud', free: true, defaultModel: 'gemini-flash-latest',
      models: [
        { name: 'gemini-flash-latest', label: 'Gemini Flash', vision: true, canThink: true, contextWindowTokens: 1, budgetCapTokens: 1, free: true, freeQuota: { requestsPerMinute: 5, requestsPerDay: 20 } },
        { name: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite', vision: true, canThink: true, contextWindowTokens: 1, budgetCapTokens: 1, free: true, freeQuota: { requestsPerMinute: 15, requestsPerDay: 500 } },
        { name: 'gemini-pro-latest', label: 'Gemini Pro', vision: true, canThink: true, contextWindowTokens: 1, budgetCapTokens: 1, free: false },
      ],
    },
    groq: {
      label: 'Groq', kind: 'cloud', free: true, defaultModel: 'openai/gpt-oss-120b',
      models: [
        { name: 'openai/gpt-oss-120b', label: 'gpt-oss 120B', vision: false, canThink: true, contextWindowTokens: 1, budgetCapTokens: 1, free: true, freeQuota: { requestsPerMinute: 30, tokensPerDay: 200000 } },
      ],
    },
    openai: {
      label: 'OpenAI', kind: 'cloud', free: false, defaultModel: 'gpt-4o-mini',
      models: [
        { name: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true, canThink: false, contextWindowTokens: 1, budgetCapTokens: 1, free: false },
      ],
    },
    ollama: { label: 'Ollama (local)', kind: 'local', free: true, defaultModel: 'qwen3.5:9b', models: [] },
  },
} as unknown as Registry;

const settings = {
  llm_provider: 'gemini',
  gemini_model: 'gemini-flash-latest',
  gemini_api_key_set: true,
  groq_model: 'openai/gpt-oss-120b',
  groq_api_key_set: true,
  openai_api_key_set: false,
} as unknown as Settings;

const LABELS = { free: 'Free', paid: 'Requires billing', local: 'Local · Ollama' };

describe('buildPickerGroups (cost tiers)', () => {
  it('groups free models of every keyed provider into one tier group', () => {
    const groups = buildPickerGroups(settings, registry, [], LABELS);
    const free = groups.find(g => g.tier === 'free')!;
    expect(free.label).toBe('Free');
    expect(free.models.map(m => m.name)).toEqual([
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'openai/gpt-oss-120b',
    ]);
    // Rows carry their provider — the group no longer does.
    expect(free.models[0].provider).toBe('gemini');
    expect(free.models[0].providerLabel).toBe('Gemini');
    // Request quota rides along for the meter; token-limited Groq gets none.
    expect(free.models[0].requestsPerDay).toBe(20);
    expect(free.models[2].requestsPerDay).toBeUndefined();
  });

  it('collects paid-only models of keyed providers into the billing group', () => {
    const groups = buildPickerGroups(settings, registry, [], LABELS);
    const paid = groups.find(g => g.tier === 'paid')!;
    expect(paid.models.map(m => m.name)).toEqual(['gemini-pro-latest']);
    expect(paid.models[0].free).toBe(false);
    // OpenAI has no key — its paid models stay hidden.
    expect(paid.models.some(m => m.provider === 'openai')).toBe(false);
  });

  it('omits the billing group when no keyed provider has paid models', () => {
    const groqOnly = { ...settings, gemini_api_key_set: false } as unknown as Settings;
    const groups = buildPickerGroups(groqOnly, registry, [], LABELS);
    expect(groups.find(g => g.tier === 'paid')).toBeUndefined();
  });

  it('keeps the local group last and always present', () => {
    const groups = buildPickerGroups(settings, registry, [{ name: 'qwen3.5:9b' }], LABELS);
    const last = groups[groups.length - 1];
    expect(last.tier).toBe('local');
    expect(last.local).toBe(true);
    expect(last.models[0].name).toBe('qwen3.5:9b');
  });

  it('puts the active provider’s selected model first in the free group', () => {
    const groqActive = { ...settings, llm_provider: 'groq' } as unknown as Settings;
    const groups = buildPickerGroups(groqActive, registry, [], LABELS);
    const free = groups.find(g => g.tier === 'free')!;
    expect(free.models[0].name).toBe('openai/gpt-oss-120b');
  });
});
