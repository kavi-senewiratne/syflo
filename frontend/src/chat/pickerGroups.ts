/**
 * chat/pickerGroups.ts
 *
 * Builds the grouped model-picker data (mockup-model-cost-tiers W2b, chosen
 * 2026-07-30): COST TIER is the grouping axis — "free" collects the
 * free-tier models of every cloud provider WITH a key set, "paid" the
 * paid-only ones (omitted when empty), the local group is always last and
 * always present so the private option never silently disappears. The
 * provider moves onto each row (name + label); keyless providers are
 * hidden — the picker's "Manage models" row is the path to setting them up.
 *
 * G3 (mockup-onboarding-flow §07, chosen 2026-08-15) adds one exception to
 * that hiding: a keyless provider with a FREE tier gets a row in its own
 * "to set up" group, between the cost tiers and the local group. It is the
 * only group whose rows cannot be selected — there is no key to use yet.
 */

import type { PickerGroup, PickerModel } from '../components/ChatArea/ModelPicker';
import type { LLMProvider, OllamaModelInfo, Registry, Settings } from '../types';

export interface PickerGroupLabels {
  free: string;
  paid: string;
  local: string;
  // G3 (mockup-onboarding-flow §07): header of the "to set up" group.
  // Optional so the picker still builds where the caller has not passed it
  // yet — a group without a header would render as a nameless section, so
  // without the label the group is left out entirely.
  setup: string;
}

export function buildPickerGroups(
  settings: Settings,
  registry: Registry | null,
  ollamaModels: OllamaModelInfo[],
  labels: PickerGroupLabels,
): PickerGroup[] {
  const free: PickerModel[] = [];
  const paid: PickerModel[] = [];
  if (registry) {
    // The active provider leads so its selected model tops the free group.
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
        (m.free === false ? paid : free).push(row);
      }
    }
  }
  const groups: PickerGroup[] = [];
  if (free.length > 0) groups.push({ tier: 'free', label: labels.free, models: free });
  if (paid.length > 0) groups.push({ tier: 'paid', label: labels.paid, models: paid });
  const setup = buildSetupRows(settings, registry);
  if (setup.length > 0) groups.push({ tier: 'setup', label: labels.setup, models: setup });
  groups.push({ tier: 'local', provider: 'ollama', label: labels.local, local: true, models: ollamaModels });
  return groups;
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
