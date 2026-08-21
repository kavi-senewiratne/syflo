/**
 * chat/modelOffers.ts
 *
 * The two rules behind the offers the composer and the quota card show
 * (mockup-onboarding-flow §04 V1+V2 and §07 G2, chosen 2026-08-15). Both are
 * pure functions over settings + registry so App.tsx only wires them and the
 * components only render.
 *
 * Why they live here and not in the components: the same question — "which
 * model could take over?" — is asked in two places (the image gate and the
 * daily-limit card), and both must answer it from the same data, or the app
 * would suggest a provider in one place and forget it in the other.
 */

import type {
  FreeProviderOffer,
  LLMProvider,
  OllamaModelInfo,
  Registry,
  RegistryModel,
  Settings,
  VisionGate,
  VisionSetupOption,
  VisionSwitchTarget,
} from '../types';

interface VisionGateInput {
  settings: Settings;
  registry: Registry | null;
  ollamaModels: OllamaModelInfo[];
  ollamaReachable: boolean;
}

// The active model's own row in the registry — the local provider has no
// registry models (ADR-0008's frozen fallback), so its models come from the
// Ollama daemon, which only ever reports vision-capable ones (settings.js).
function activeModelName(settings: Settings): string {
  const provider = settings.llm_provider;
  return provider === 'ollama'
    ? settings.ollama_model
    : ((settings[`${provider}_model` as keyof Settings] as string) ?? '');
}

function keySet(settings: Settings, provider: LLMProvider): boolean {
  return Boolean(settings[`${provider}_api_key_set` as keyof Settings]);
}

/**
 * Can the ACTIVE model read an image, and if not, where is the way out?
 *
 * The order of the exits is deliberate: a reachable local model wins, because
 * switching there costs no quota and keeps the image on the machine. After
 * that comes any cloud model whose provider already has a key. Only when
 * nothing configured can read images does the gate fall back to setup
 * options — that is the state a user strands in today (§04 V2).
 */
export function buildVisionGate({
  settings,
  registry,
  ollamaModels,
  ollamaReachable,
}: VisionGateInput): VisionGate {
  const provider = settings.llm_provider;
  const modelName = activeModelName(settings);
  const registryModel = (p: LLMProvider, name: string): RegistryModel | undefined =>
    registry?.providers[p]?.models.find(m => m.name === name);

  const active = registryModel(provider, modelName);
  // Local models are vision-capable by construction; cloud models say so.
  const activeReadsImages = provider === 'ollama' ? true : active?.vision !== false;
  const activeLabel = provider === 'ollama' ? modelName : active?.label ?? modelName;

  if (activeReadsImages) {
    return { activeReadsImages: true, activeLabel, switchTarget: null, setupOptions: [] };
  }

  const localVision = ollamaReachable ? ollamaModels[0] : undefined;
  if (localVision) {
    return {
      activeReadsImages: false,
      activeLabel,
      switchTarget: { provider: 'ollama', model: localVision.name, label: localVision.name },
      setupOptions: [],
    };
  }

  const configured: VisionSwitchTarget[] = [];
  const setupOptions: VisionSetupOption[] = [];
  for (const id of Object.keys(registry?.providers ?? {})) {
    const p = id as LLMProvider;
    const entry = registry?.providers[p];
    if (!entry || entry.kind !== 'cloud') continue;
    const visionModels = entry.models.filter(m => m.vision !== false);
    if (visionModels.length === 0) continue;

    if (keySet(settings, p)) {
      // Prefer the model the user already selected for that provider.
      const selected = (settings[`${p}_model` as keyof Settings] as string) ?? '';
      const pick = visionModels.find(m => m.name === selected) ?? visionModels[0];
      configured.push({ provider: p, model: pick.name, label: pick.label ?? pick.name });
      continue;
    }
    // No key: it can only be an offer, and only its FREE vision models count —
    // a paid-only model would need billing on top of the key.
    const free = visionModels.filter(m => m.free !== false);
    const pick = largestByRequests(free);
    if (!pick) continue;
    setupOptions.push({
      kind: 'cloud',
      provider: p,
      model: pick.name,
      label: pick.label ?? pick.name,
      requestsPerDay: pick.freeQuota?.requestsPerDay,
    });
  }

  return {
    activeReadsImages: false,
    activeLabel,
    switchTarget: configured[0] ?? null,
    // Setup options are the V2 case only — with a configured way out, the
    // card must not also ask the user to sign up somewhere.
    setupOptions: configured.length > 0 ? [] : setupOptions,
  };
}

function largestByRequests(models: RegistryModel[]): RegistryModel | undefined {
  if (models.length === 0) return undefined;
  return models.reduce((best, m) =>
    (m.freeQuota?.requestsPerDay ?? 0) > (best.freeQuota?.requestsPerDay ?? 0) ? m : best,
  );
}

interface FreeProviderOfferInput {
  settings: Settings;
  registry: Registry | null;
  // Pre-formatted quota lines in the app language (strings.ts owns the wording).
  labels: { requestsPerDay: (n: number) => string; tokensPerDay: (n: number) => string };
  // The provider whose limit just hit — offering it back would be absurd.
  excludeProvider?: LLMProvider;
}

/**
 * The free cloud provider still missing a key (§07 G2). Same rule as the
 * picker's "to set up" group, so the daily-limit card and the picker never
 * disagree about what is missing.
 */
export function buildFreeProviderOffer({
  settings,
  registry,
  labels,
  excludeProvider,
}: FreeProviderOfferInput): FreeProviderOffer | null {
  for (const id of Object.keys(registry?.providers ?? {})) {
    const p = id as LLMProvider;
    if (p === excludeProvider) continue;
    const entry = registry?.providers[p];
    if (!entry || entry.kind !== 'cloud') continue;
    if (keySet(settings, p)) continue;
    const free = entry.models.filter(m => m.free !== false);
    if (free.length === 0) continue;
    const best = largestFreeAllowance(free);
    const requests = best.freeQuota?.requestsPerDay;
    const tokens = best.freeQuota?.tokensPerDay;
    if (typeof requests !== 'number' && typeof tokens !== 'number') continue;
    return {
      provider: p,
      label: entry.label ?? p,
      quota: typeof requests === 'number' ? labels.requestsPerDay(requests) : labels.tokensPerDay(tokens as number),
      readsImages: best.vision !== false,
    };
  }
  return null;
}

// Same comparison rule as pickerGroups' largestFreeQuota: requests win
// wherever any model states them, tokens are only compared among themselves.
function largestFreeAllowance(models: RegistryModel[]): RegistryModel {
  const byRequests = models.filter(m => typeof m.freeQuota?.requestsPerDay === 'number');
  const pool = byRequests.length > 0 ? byRequests : models;
  const size = (m: RegistryModel) =>
    byRequests.length > 0 ? m.freeQuota?.requestsPerDay ?? 0 : m.freeQuota?.tokensPerDay ?? 0;
  return pool.reduce((best, m) => (size(m) > size(best) ? m : best), pool[0]);
}
