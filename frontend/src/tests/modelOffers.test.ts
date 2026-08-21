/**
 * tests/modelOffers.test.ts
 *
 * The two rules App.tsx needs to hand the composer and the quota card their
 * offers (mockup-onboarding-flow §04 V1+V2 and §07 G2):
 *   - buildVisionGate: can the ACTIVE model read an image, and if not, what
 *     is the way out — a configured vision model, or one to set up?
 *   - buildFreeProviderOffer: which free provider is still missing a key?
 */

import { describe, it, expect } from 'vitest';
import { buildVisionGate, buildFreeProviderOffer } from '../chat/modelOffers';
import type { OllamaModelInfo, Registry, Settings } from '../types';

const REGISTRY: Registry = {
  asOf: '2026-08-01',
  providers: {
    gemini: {
      label: 'Gemini',
      kind: 'cloud',
      free: true,
      defaultModel: 'gemini-flash-latest',
      models: [
        {
          name: 'gemini-flash-latest',
          label: 'Gemini Flash',
          vision: true,
          free: true,
          freeQuota: { requestsPerDay: 20 },
        },
        {
          name: 'gemini-flash-lite-latest',
          label: 'Gemini Flash Lite',
          vision: true,
          free: true,
          freeQuota: { requestsPerDay: 500 },
        },
      ],
    },
    groq: {
      label: 'Groq',
      kind: 'cloud',
      free: true,
      defaultModel: 'llama-3.3-70b-versatile',
      models: [
        {
          name: 'llama-3.3-70b-versatile',
          label: 'Llama 3.3 70B',
          vision: false,
          free: true,
          freeQuota: { tokensPerDay: 100_000 },
        },
      ],
    },
    ollama: { label: 'Ollama (local)', kind: 'local', free: true, defaultModel: 'qwen3.5:9b', models: [] },
  },
} as unknown as Registry;

const settings = (over: Partial<Settings> = {}): Settings =>
  ({
    llm_provider: 'groq',
    groq_model: 'llama-3.3-70b-versatile',
    gemini_model: 'gemini-flash-lite-latest',
    ollama_model: 'qwen3.5:9b',
    gemini_api_key_set: true,
    groq_api_key_set: true,
    ...over,
  }) as unknown as Settings;

const LOCAL_VISION: OllamaModelInfo[] = [{ name: 'qwen3.5:9b', parameter_size: '9.7B' } as OllamaModelInfo];

describe('buildVisionGate', () => {
  it('reports the active model as image-capable when the registry says so', () => {
    const gate = buildVisionGate({
      settings: settings({ llm_provider: 'gemini' }),
      registry: REGISTRY,
      ollamaModels: [],
      ollamaReachable: false,
    });
    expect(gate.activeReadsImages).toBe(true);
    expect(gate.activeLabel).toBe('Gemini Flash Lite');
    expect(gate.switchTarget).toBeNull();
    expect(gate.setupOptions).toEqual([]);
  });

  it('names a configured vision model as the way out of a text-only model', () => {
    const gate = buildVisionGate({
      settings: settings(),
      registry: REGISTRY,
      ollamaModels: [],
      ollamaReachable: false,
    });
    expect(gate.activeReadsImages).toBe(false);
    expect(gate.activeLabel).toBe('Llama 3.3 70B');
    expect(gate.switchTarget).toEqual({
      provider: 'gemini',
      model: 'gemini-flash-lite-latest',
      label: 'Gemini Flash Lite',
    });
  });

  it('prefers the local model as the way out while Ollama is reachable', () => {
    // The private path wins when it is actually available: switching there
    // costs no quota at all (ADR-0008's local-as-fallback stance).
    const gate = buildVisionGate({
      settings: settings({ gemini_api_key_set: false }),
      registry: REGISTRY,
      ollamaModels: LOCAL_VISION,
      ollamaReachable: true,
    });
    expect(gate.switchTarget).toEqual({ provider: 'ollama', model: 'qwen3.5:9b', label: 'qwen3.5:9b' });
  });

  it('offers the free providers to set up when nothing configured reads images', () => {
    const gate = buildVisionGate({
      settings: settings({ gemini_api_key_set: false }),
      registry: REGISTRY,
      ollamaModels: [],
      ollamaReachable: false,
    });
    expect(gate.switchTarget).toBeNull();
    expect(gate.setupOptions).toEqual([
      {
        kind: 'cloud',
        provider: 'gemini',
        model: 'gemini-flash-lite-latest',
        label: 'Gemini Flash Lite',
        requestsPerDay: 500,
      },
    ]);
  });

  it('leaves out a keyless provider whose free models are text-only', () => {
    // Groq has no key here either, but adding it would not solve the image
    // problem — the offer must only list models that actually read images.
    const gate = buildVisionGate({
      settings: settings({ gemini_api_key_set: false, groq_api_key_set: false }),
      registry: REGISTRY,
      ollamaModels: [],
      ollamaReachable: false,
    });
    expect(gate.setupOptions.map(o => o.provider)).toEqual(['gemini']);
  });
});

describe('buildFreeProviderOffer', () => {
  const labels = {
    requestsPerDay: (n: number) => `free · ${n} questions a day`,
    tokensPerDay: (n: number) => `free · ${n} tokens a day`,
  };

  it('offers the free provider that has no key yet', () => {
    const offer = buildFreeProviderOffer({
      settings: settings({ groq_api_key_set: false }),
      registry: REGISTRY,
      labels,
    });
    expect(offer).toEqual({
      provider: 'groq',
      label: 'Groq',
      quota: 'free · 100000 tokens a day',
      readsImages: false,
    });
  });

  it('never offers the provider whose limit just hit', () => {
    const offer = buildFreeProviderOffer({
      settings: settings({ groq_api_key_set: false }),
      registry: REGISTRY,
      labels,
      excludeProvider: 'groq',
    });
    expect(offer).toBeNull();
  });

  it('offers nothing once every free provider has a key', () => {
    const offer = buildFreeProviderOffer({ settings: settings(), registry: REGISTRY, labels });
    expect(offer).toBeNull();
  });
});
