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
 */

import type { PickerGroup, PickerModel } from '../components/ChatArea/ModelPicker';
import type { LLMProvider, OllamaModelInfo, Registry, Settings } from '../types';

export interface PickerGroupLabels {
  free: string;
  paid: string;
  local: string;
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
  groups.push({ tier: 'local', provider: 'ollama', label: labels.local, local: true, models: ollamaModels });
  return groups;
}
