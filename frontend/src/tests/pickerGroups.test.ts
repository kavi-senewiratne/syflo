/**
 * tests/pickerGroups.test.ts
 *
 * Availability-grouped picker data (mockup-onboarding-flow §02, chosen
 * 2026-08-15): the models of every KEYED provider form one 'usable' bundle,
 * free ones first, with the cost tier carried on the row instead of in a
 * group header. The local group is always last. Which of those rows is
 * usable RIGHT NOW is decided later, by splitByAvailability in the picker.
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

const LABELS = { local: 'Local · Ollama', setup: 'To set up' };

// G3 (mockup-onboarding-flow §07): only Gemini has a key, so Groq's free
// tier is the gap the picker must make visible.
const geminiOnly = { ...settings, groq_api_key_set: false } as unknown as Settings;

describe('buildPickerGroups (one usable bundle)', () => {
  it('puts the models of every keyed provider in one group, free ones first', () => {
    const groups = buildPickerGroups(settings, registry, [], LABELS);
    const usable = groups.find(g => g.tier === 'usable')!;
    // Cost no longer splits the list, it only orders it: the paid Gemini Pro
    // comes last, and the group has no cost label at all.
    expect(usable.models.map(m => m.name)).toEqual([
      'gemini-flash-latest',
      'gemini-flash-lite-latest',
      'openai/gpt-oss-120b',
      'gemini-pro-latest',
    ]);
    expect(usable.models.at(-1)!.free).toBe(false);
    // Rows carry their provider — the group no longer does.
    expect(usable.models[0].provider).toBe('gemini');
    expect(usable.models[0].providerLabel).toBe('Gemini');
    // Request quota rides along for the meter; token-limited Groq gets none.
    expect(usable.models[0].requestsPerDay).toBe(20);
    expect(usable.models[2].requestsPerDay).toBeUndefined();
  });

  it('hides the models of providers without a key', () => {
    const groups = buildPickerGroups(settings, registry, [], LABELS);
    const usable = groups.find(g => g.tier === 'usable')!;
    // OpenAI has no key — neither its paid nor any other model shows up.
    expect(usable.models.some(m => m.provider === 'openai')).toBe(false);
  });

  it('omits the cloud group entirely when no provider has a key', () => {
    const noKeys = { ...settings, gemini_api_key_set: false, groq_api_key_set: false } as unknown as Settings;
    const groups = buildPickerGroups(noKeys, registry, [], LABELS);
    // First start: nothing usable, everything still to set up — and no
    // headline over an empty list.
    expect(groups.find(g => g.tier === 'usable')).toBeUndefined();
  });

  it('keeps the local group last and always present', () => {
    const groups = buildPickerGroups(settings, registry, [{ name: 'qwen3.5:9b' }], LABELS);
    const last = groups[groups.length - 1];
    expect(last.tier).toBe('local');
    expect(last.local).toBe(true);
    expect(last.models[0].name).toBe('qwen3.5:9b');
  });

  it('puts the active provider’s selected model first', () => {
    const groqActive = { ...settings, llm_provider: 'groq' } as unknown as Settings;
    const groups = buildPickerGroups(groqActive, registry, [], LABELS);
    const usable = groups.find(g => g.tier === 'usable')!;
    expect(usable.models[0].name).toBe('openai/gpt-oss-120b');
  });
});

// G3 (mockup-onboarding-flow §07, chosen 2026-08-15): free providers WITHOUT
// a key get their own group — one row per PROVIDER, named after its
// largest-quota free model, so the gap is visible without a nag.
describe('buildPickerGroups (setup group)', () => {
  it('lists every free cloud provider without a key as one row', () => {
    const groups = buildPickerGroups(geminiOnly, registry, [], LABELS);
    const setup = groups.find(g => g.tier === 'setup')!;
    expect(setup.label).toBe('To set up');
    expect(setup.models).toHaveLength(1);
    expect(setup.models[0].provider).toBe('groq');
    // The row is titled by the PROVIDER (mockup G3) — it stands for the
    // whole free tier, not for one model.
    expect(setup.models[0].label).toBe('Groq');
    // OpenAI is keyless too, but has no free tier — nothing to offer.
    expect(setup.models.some(m => m.provider === 'openai')).toBe(false);
  });

  it('advertises the largest free quota per provider, in the shape the provider states it', () => {
    const noKeys = { ...settings, gemini_api_key_set: false, groq_api_key_set: false } as unknown as Settings;
    // Groq states two token allowances — the bigger one must win.
    const withTwoGroqModels = {
      ...registry,
      providers: {
        ...registry.providers,
        groq: {
          ...registry.providers.groq,
          models: [
            ...registry.providers.groq!.models,
            { name: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', vision: false, canThink: false, contextWindowTokens: 1, budgetCapTokens: 1, free: true, freeQuota: { requestsPerMinute: 30, tokensPerDay: 100000 } },
          ],
        },
      },
    } as unknown as Registry;
    const setup = buildPickerGroups(noKeys, withTwoGroqModels, [], LABELS).find(g => g.tier === 'setup')!;
    const gemini = setup.models.find(m => m.provider === 'gemini')!;
    const groq = setup.models.find(m => m.provider === 'groq')!;
    // Gemini counts requests: Flash Lite's 500/day beats Flash's 20/day.
    expect(gemini.name).toBe('gemini-flash-lite-latest');
    expect(gemini.requestsPerDay).toBe(500);
    expect(gemini.tokensPerDay).toBeUndefined();
    // Groq counts tokens: 200.000/day beats 100.000/day.
    expect(groq.name).toBe('openai/gpt-oss-120b');
    expect(groq.tokensPerDay).toBe(200000);
    expect(groq.requestsPerDay).toBeUndefined();
  });

  it('carries the advertised model’s vision flag so text-only providers say so', () => {
    const noKeys = { ...settings, gemini_api_key_set: false, groq_api_key_set: false } as unknown as Settings;
    const setup = buildPickerGroups(noKeys, registry, [], LABELS).find(g => g.tier === 'setup')!;
    expect(setup.models.find(m => m.provider === 'gemini')!.vision).toBe(true);
    expect(setup.models.find(m => m.provider === 'groq')!.vision).toBe(false);
  });

  it('sits behind the usable models and ahead of the local group', () => {
    const groups = buildPickerGroups(geminiOnly, registry, [{ name: 'qwen3.5:9b' }], LABELS);
    expect(groups.map(g => g.tier)).toEqual(['usable', 'setup', 'local']);
  });

  it('omits the group when every free provider already has a key', () => {
    const groups = buildPickerGroups(settings, registry, [], LABELS);
    expect(groups.find(g => g.tier === 'setup')).toBeUndefined();
  });
});
