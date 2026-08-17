/**
 * components/SettingsModal/ModelTierList.tsx
 *
 * Step 2 of the model tab for cloud providers (mockup-model-cost-tiers
 * Variante B, chosen 2026-07-30): a radio list grouped by COST TIER —
 * "Free tier" rows carry a live used/limit meter (or the static registry
 * quota while no key is saved, W5), "Requires billing" rows a lock and the
 * price. An exhausted daily quota turns the meter into a countdown to the
 * reset (W1); the W10 tooltip on the group header explains the mental
 * model once: the tier belongs to the KEY, not to the model.
 *
 * Standard theme tokens only: green/amber for the tier headers (the
 * families the picker badges already use), red strictly for the exhausted
 * state, blue for selection.
 */

import { useEffect, useState } from 'react';
import { Check, CreditCard, Info, Lock } from 'lucide-react';
import { useStrings } from '../../strings';
import type { RegistryModel } from '../../types';

export interface TierCooldown {
  until: string;
  kind?: string;
}

interface Props {
  // Provider id — keys the usage/cooldown lookups ('provider/model').
  provider: string;
  models: RegistryModel[];
  value: string;
  onChange: (name: string) => void;
  // Without a key there is no usage yet — static registry quotas render
  // instead of meters, so the list doesn't reflow when the key is saved.
  keySet: boolean;
  modelsToday: Record<string, number>;
  cooldowns: Record<string, TierCooldown>;
}

// "6h 12m" — the row answers "how long?", the group note "when exactly?".
function formatResetCountdown(remainingMs: number): string {
  const h = Math.floor(remainingMs / 3_600_000);
  const m = Math.ceil((remainingMs % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function ModelTierList({ provider, models, value, onChange, keySet, modelsToday, cooldowns }: Props) {
  const S = useStrings().settings.model;
  const free = models.filter(m => m.free !== false);
  const paid = models.filter(m => m.free === false);

  // Free quotas reset at UTC midnight — shown once in the group header as
  // the user's local wall-clock time.
  const now = new Date();
  const resetTime = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Fetch-on-open is enough (user decision 2026-07-30); only the countdown
  // ticks client-side, minute-coarse.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyCooldown = Object.keys(cooldowns).length > 0;
  useEffect(() => {
    if (!anyCooldown) return;
    setNowMs(Date.now());
    const t = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [anyCooldown]);

  const groupHead = (tier: 'free' | 'paid') => (
    <div
      className={`flex items-center justify-between px-3 py-1.5 bg-gray-50 border-b border-gray-100 ${
        tier === 'free' ? 'text-green-700' : 'text-amber-700'
      }`}
    >
      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
        {tier === 'free' ? <Check size={10} className="shrink-0" /> : <CreditCard size={10} className="shrink-0" />}
        {tier === 'free' ? S.tierFree : S.tierPaid}
        {tier === 'free' && (
          <span data-testid="tier-info" data-tip={S.tierTooltip} aria-label={S.tierTooltip} className="text-gray-400 cursor-help">
            <Info size={10} />
          </span>
        )}
      </span>
      <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">
        {tier === 'free' ? S.tierFreeNote(resetTime) : S.tierPaidNote}
      </span>
    </div>
  );

  const row = (m: RegistryModel) => {
    const paidRow = m.free === false;
    const quota = m.freeQuota?.requestsPerDay;
    const entry = cooldowns[`${provider}/${m.name}`];
    const remainingMs = entry ? new Date(entry.until).getTime() - nowMs : 0;
    const dailyCooling = entry?.kind === 'daily' && remainingMs > 0;
    const used = modelsToday[`${provider}/${m.name}`] ?? 0;
    const selected = m.name === value;
    const subtitle = [paidRow ? S.billingNeeded : null, m.vision ? null : S.textOnlyBadge]
      .filter(Boolean)
      .join(' · ');
    return (
      <button
        key={m.name}
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={() => onChange(m.name)}
        data-testid={`settings-model-${m.name}`}
        className={`w-full flex items-center gap-2.5 px-3 py-2 text-left border-b border-gray-50 last:border-b-0 transition-colors ${
          selected ? 'bg-blue-50' : 'hover:bg-gray-50'
        }`}
      >
        <span
          className={`shrink-0 w-3.5 h-3.5 rounded-full border ${
            selected ? 'border-blue-600 border-[4.5px] bg-white' : 'border-gray-300 bg-white'
          }`}
        />
        <span className="flex-1 min-w-0">
          <span className={`flex items-center gap-1.5 text-[13px] font-medium truncate ${paidRow ? 'text-gray-400' : 'text-gray-900'}`}>
            {m.label}
            {paidRow && <Lock size={11} className="shrink-0 text-gray-400" />}
          </span>
          {subtitle && <span className="block text-[11px] text-gray-500">{subtitle}</span>}
        </span>
        {paidRow ? (
          <span className="shrink-0 font-mono text-[10.5px] text-gray-400 whitespace-nowrap">
            {m.pricing ? S.priceMTok(m.pricing.inputPerMTok) : null}
          </span>
        ) : typeof quota === 'number' ? (
          <span
            data-testid={`settings-quota-${m.name}`}
            className={`shrink-0 inline-flex items-center gap-1.5 font-mono text-[10.5px] whitespace-nowrap ${
              dailyCooling ? 'text-red-600' : 'text-gray-400'
            }`}
          >
            {keySet && (
              <span className="w-9 h-1 rounded-full bg-gray-200 overflow-hidden">
                <span
                  className={`block h-full rounded-full ${dailyCooling ? 'bg-red-500' : 'bg-green-600'}`}
                  style={{ width: `${dailyCooling ? 100 : Math.min(100, Math.round((used / quota) * 100))}%` }}
                />
              </span>
            )}
            {!keySet ? S.perDay(quota) : dailyCooling ? formatResetCountdown(remainingMs) : `${used}/${quota}`}
          </span>
        ) : (
          <span className="shrink-0 text-[9.5px] font-semibold uppercase tracking-wide text-green-700 bg-green-50 rounded-full px-1.5 py-0.5">
            {S.costFree}
          </span>
        )}
      </button>
    );
  };

  return (
    <div role="radiogroup" data-testid="cloud-model-list" className="rounded-lg border border-gray-200 overflow-hidden">
      {free.length > 0 && groupHead('free')}
      {free.map(row)}
      {paid.length > 0 && groupHead('paid')}
      {paid.map(row)}
    </div>
  );
}
