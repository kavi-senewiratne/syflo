/**
 * chat/pickerGroups.ts
 *
 * Builds the grouped model-picker data. AVAILABILITY is the grouping axis
 * (mockup-onboarding-flow §02, chosen 2026-08-15), which replaced the cost
 * tiers of 2026-07-30: "free" and "paid" were true but answered the wrong
 * question — the reader wants to know what will answer right now, and the
 * price belongs on the row (provider · cost · image ability).
 *
 * So the cloud models of every provider WITH a key form one 'usable' bundle
 * here; splitByAvailability peels the cooling, unknown and retired ones off
 * into 'unavailable' at render time, where the live quota memory is known.
 * The local group is always last and always present so the private option
 * never silently disappears. Keyless providers are hidden — except:
 *
 * G3 (mockup-onboarding-flow §07, chosen 2026-08-15): a keyless provider with
 * a FREE tier gets a row in its own "to set up" group, ahead of the local
 * group. It is deliberately NOT merged into "not usable right now" (§02):
 * nothing there is broken, it was only never set up — two states, two words.
 * It is the only group whose rows cannot be selected.
 */

import type { PickerGroup, PickerModel } from '../components/ChatArea/ModelPicker';
import type { LLMProvider, OllamaModelInfo, Registry, Settings } from '../types';

export interface PickerGroupLabels {
  local: string;
  // G3 (mockup-onboarding-flow §07): header of the "to set up" group.
  setup: string;
  // Cost tiers stopped being groups in §02 (2026-08-15) — these two are
  // accepted and ignored so the caller that still passes them keeps
  // compiling. The availability groups are named by the picker itself.
  free?: string;
  paid?: string;
}

export function buildPickerGroups(
  settings: Settings,
  registry: Registry | null,
  ollamaModels: OllamaModelInfo[],
  labels: PickerGroupLabels,
): PickerGroup[] {
  const cloud: PickerModel[] = [];
  if (registry) {
    // The active provider leads so its selected model tops the first group.
    const ids = Object.keys(registry.providers).sort((a, b) =>
      a === settings.llm_provider ? -1 : b === settings.llm_provider ? 1 : 0,
    );
    for (const id of ids) {
      const provider = registry.providers[id as LLMProvider];
      if (!provider || provider.kind !== 'cloud') continue;
      if (!settings[`${id}_api_key_set` as keyof Settings]) continue;
      const selected = settings[`${id}_model` as keyof Settings];
      const models = [...provider.models].sort((a, b) =>
        a.name === selected ? -1 : b.name === selected ? 1 : 0,
      );
      for (const m of models) {
        const row: PickerModel = {
          name: m.name,
          label: m.label,
          canThink: m.canThink,
          vision: m.vision,
          provider: id as LLMProvider,
          providerLabel: provider.label ?? id,
          free: m.free !== false,
          // Meter only for request-shaped quotas (W8 rule): token-limited
          // models would fake a safety the counter cannot promise.
          requestsPerDay: m.freeQuota?.requestsPerDay,
        };
        cloud.push(row);
      }
    }
  }
  const groups: PickerGroup[] = [];
  // One cloud bundle, free and paid mixed: cost is a word on the row now
  // (§02). Free models lead so the cheapest choice is the first one read —
  // the ladder itself avoids paid models (cost tiers, 2026-07-30).
  const byCost = [...cloud].sort((a, b) => Number(a.free === false) - Number(b.free === false));
  if (byCost.length > 0) groups.push({ tier: 'usable', models: byCost });
  const setup = buildSetupRows(settings, registry);
  if (setup.length > 0) groups.push({ tier: 'setup', label: labels.setup, models: setup });
  groups.push({ tier: 'local', provider: 'ollama', label: labels.local, local: true, models: ollamaModels });
  return groups;
}

/**
 * Second half of the grouping (mockup-onboarding-flow §02, chosen
 * 2026-08-15): whether a model is usable RIGHT NOW is known only from the
 * live quota memory, which reaches the picker over
 * GET /api/quota-cooldowns — so buildPickerGroups hands out one 'usable'
 * bundle and the picker splits it here, at render time.
 *
 * An empty group is left out entirely: on a fresh install "not usable right
 * now" has no members and used to render as a headline over nothing, which
 * read like a damage report on an app where nothing was wrong yet.
 */
export function splitByAvailability(
  groups: PickerGroup[],
  isUnavailable: (provider: LLMProvider, model: string) => boolean,
): PickerGroup[] {
  const out: PickerGroup[] = [];
  for (const group of groups) {
    if (group.tier !== 'usable') {
      out.push(group);
      continue;
    }
    const usable: PickerModel[] = [];
    const unavailable: PickerModel[] = [];
    for (const model of group.models) {
      const provider = (model.provider ?? group.provider) as LLMProvider;
      (isUnavailable(provider, model.name) ? unavailable : usable).push(model);
    }
    if (usable.length > 0) out.push({ ...group, models: usable });
    if (unavailable.length > 0) out.push({ ...group, tier: 'unavailable', models: unavailable });
  }
  return out;
}

/**
 * G3 (mockup-onboarding-flow §07, chosen 2026-08-15): one row per free cloud
 * provider whose key is still missing. A provider — not a model — is what the
 * user sets up, so the row is titled by the provider; the quota it advertises
 * comes from the provider's largest free model, read from the registry
 * (never hardcoded: registry.json is refreshed remotely).
 */
export function buildSetupRows(settings: Settings, registry: Registry | null): PickerModel[] {
  const rows: PickerModel[] = [];
  if (!registry) return rows;
  for (const id of Object.keys(registry.providers)) {
    const provider = registry.providers[id as LLMProvider];
    if (!provider || provider.kind !== 'cloud') continue;
    if (settings[`${id}_api_key_set` as keyof Settings]) continue;
    const freeModels = provider.models.filter(m => m.free !== false);
    if (freeModels.length === 0) continue;
    const best = largestFreeQuota(freeModels);
    rows.push({
      name: best.name,
      label: provider.label ?? id,
      provider: id as LLMProvider,
      providerLabel: provider.label ?? id,
      free: true,
      vision: best.vision,
      requestsPerDay: best.freeQuota?.requestsPerDay,
      tokensPerDay: best.freeQuota?.tokensPerDay,
    });
  }
  return rows;
}

/**
 * The free model whose daily allowance is biggest. Providers state that
 * allowance in one shape only — Gemini in requests, Groq in tokens — so
 * requests win the comparison wherever any model states them, and tokens
 * are compared only among themselves. Comparing across the two would be
 * meaningless (200000 tokens is not 200000 questions).
 */
function largestFreeQuota<T extends { freeQuota?: { requestsPerDay?: number; tokensPerDay?: number } }>(
  models: T[],
): T {
  const byRequests = models.filter(m => typeof m.freeQuota?.requestsPerDay === 'number');
  const pool = byRequests.length > 0 ? byRequests : models;
  const size = (m: T) =>
    byRequests.length > 0 ? m.freeQuota?.requestsPerDay ?? 0 : m.freeQuota?.tokensPerDay ?? 0;
  return pool.reduce((best, m) => (size(m) > size(best) ? m : best), pool[0]);
}
