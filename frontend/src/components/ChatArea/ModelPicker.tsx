/**
 * components/ChatArea/ModelPicker.tsx
 *
 * The model pill at the bottom right of the composer + its grouped drop-up
 * menu (design/mockup-model-flow.html §02–§04). One group per provider WITH
 * a key set plus the local group — selecting any row switches provider AND
 * model in one click. Cooldown badges span all providers (unfiltered
 * /api/quota-cooldowns); the footer is honest about Ollama's state; the
 * menu renders independently of the pill's visibility so the quota cards'
 * "Modell wechseln" works in narrow columns too.
 *
 * The menu itself goes through <Popover> (design/mockup-model-picker-truth
 * §01, variant A): as an `absolute` child of the composer the 288 px panel
 * was cut off by the chat pane's `overflow-hidden` as soon as the column
 * got narrower than the panel — the user's screenshot showed a menu with no
 * left half. The panel keeps its own look; only position moved out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Clock, CreditCard, Info, Lightbulb, Lock, Plus, Zap } from 'lucide-react';
import { api } from '../../api';
import { Popover } from '../Popover';
import { useStrings } from '../../strings';
import type { LLMProvider } from '../../types';

// One row in the drop-up: local Ollama models (name + parameter_size) and
// cloud registry models (name + label + canThink + vision) share this shape.
export interface PickerModel {
  name: string;
  label?: string;
  size?: number;
  parameter_size?: string;
  canThink?: boolean;
  // Cloud registry flag — text-only rows are labeled so the vision trap is
  // visible BEFORE the click (§05 no_vision card's "Modell wechseln" exit).
  vision?: boolean;
  // Tier groups mix providers (mockup-model-cost-tiers W2b): cloud rows
  // carry their own provider; the subline names it.
  provider?: LLMProvider;
  providerLabel?: string;
  free?: boolean;
  // Free quota for the meter chip — absent for token-limited models (Groq),
  // whose request counter would suggest a safety that doesn't exist.
  requestsPerDay?: number;
  // Token-shaped daily allowance (Groq). Only the setup group shows it: as a
  // plain number in the subline, never as a meter — nothing counts tokens
  // for a provider that has no key yet.
  tokensPerDay?: number;
}

// One group in the drop-up: a cost tier (free / requires billing) or the
// local group. Cost is the grouping axis (W2b, chosen 2026-07-30) because
// several providers mix free and paid models.
export interface PickerGroup {
  // 'setup' (G3, mockup-onboarding-flow §07) is the one group whose rows are
  // NOT selectable: they name free providers that still need a key.
  tier?: 'free' | 'paid' | 'local' | 'setup';
  // Group-level provider: only the local group has one; cloud rows carry
  // their provider per model.
  provider?: LLMProvider;
  label: string;
  local?: boolean;
  models: PickerModel[];
}

interface CooldownEntry {
  until: string;
  kind?: string;
}

export interface ModelPickerProps {
  activeProvider: LLMProvider;
  activeModel: string;
  groups: PickerGroup[];
  // Honest local state (§02): reachable-with-zero-vision-models is a
  // DIFFERENT situation from "not reachable" and gets different copy.
  ollamaReachable: boolean;
  // Footer count — the app cannot know a cloud provider is actually up, so
  // it never fakes a green dot for the cloud (§02 footer honesty).
  cloudCount: number;
  onSelectModel: (provider: LLMProvider, name: string) => void;
  // Thinking row: only visible when the active model can think.
  think: boolean;
  onToggleThink: () => void;
  // "Manage models" / local hint rows → Settings, model tab.
  onOpenSettings: () => void;
  // G3 (mockup-onboarding-flow §07): a row of the "to set up" group leads to
  // the key form of THAT provider. Without the handler the row falls back to
  // the generic Settings path, so the door is never a dead end.
  onSetupProvider?: (provider: LLMProvider) => void;
  disabled?: boolean;
  // External open request (quota card v3, "Modell wechseln"): every
  // increment opens the drop-up — a counter instead of a boolean so
  // repeated clicks re-open it after the user dismissed the menu.
  openSignal?: number;
  // Cooldown refresh request (bumped by the app after stream errors) —
  // together with menu-open and window focus these are the only refresh
  // moments; no polling (§03).
  refreshSignal?: number;
  // Open/close notification (auto-retry, user decision 2026-07-29): the app
  // arms a pending card retry when "Modell wechseln" opens the menu and must
  // disarm it when the menu closes without a pick. Must be referentially
  // stable (useCallback) — it sits in an effect dependency.
  onMenuOpenChange?: (open: boolean) => void;
}

export function ModelPicker({ activeProvider, activeModel, groups, ollamaReachable, cloudCount, onSelectModel, think, onToggleThink, onOpenSettings, onSetupProvider, disabled, openSignal, refreshSignal, onMenuOpenChange }: ModelPickerProps) {
  // UI copy in the app language — re-renders on language switch.
  const S = useStrings().modelPicker;
  const [open, setOpen] = useState(false);
  useEffect(() => { onMenuOpenChange?.(open); }, [open, onMenuOpenChange]);
  // The menu is measured against the ROOT, not the pill: below 19 rem the
  // pill is display:none (container query) and would measure 0x0, which
  // would park the menu in the window's top left corner. The root keeps its
  // place in the composer row either way.
  const rootRef = useRef<HTMLDivElement>(null);

  // Quota card "Modell wechseln": open on every signal INCREMENT. The ref
  // starts at the mount-time value so a remount with a historic counter
  // does not pop the menu open (audit-2 fix).
  const lastOpenSignal = useRef(openSignal ?? 0);
  useEffect(() => {
    if (openSignal === undefined || openSignal === lastOpenSignal.current) return;
    lastOpenSignal.current = openSignal;
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  // Outside click and Escape now live in Popover — the panel is no longer a
  // child of this component's subtree, so only the popover knows where it is.
  const closeMenu = useCallback(() => setOpen(false), []);

  // Tier groups mix providers — the active model is found by its row
  // provider (m.provider for cloud rows, the group's for the local one).
  const rowProvider = (g: PickerGroup, m: PickerModel): LLMProvider =>
    (m.provider ?? g.provider) as LLMProvider;
  const active = groups
    .flatMap(g => g.models.map(m => ({ g, m })))
    .find(({ g, m }) => rowProvider(g, m) === activeProvider && m.name === activeModel)?.m;
  const canThink = Boolean(active?.canThink);
  const localGroupModels = groups.find(g => g.local)?.models ?? [];

  // G3 footer (§07): "1 of 2 free providers set up" makes the gap visible
  // without advertising. Both numbers come from the groups themselves — a
  // provider with a key and a free model sits in the free tier, one without
  // a key sits in the setup group, and a keyed provider whose models are all
  // paid belongs to neither.
  const distinctProviders = (tier: PickerGroup['tier']) =>
    new Set(
      (groups.find(g => g.tier === tier)?.models ?? [])
        .filter(m => m.free !== false)
        .map(m => m.provider)
        .filter(Boolean),
    ).size;
  const freeProvidersReady = distinctProviders('free');
  const freeProvidersTotal = freeProvidersReady + distinctProviders('setup');

  const hintFor = (m: PickerModel): string =>
    m.parameter_size ? S.installedWithSize(m.parameter_size) : S.installed;

  // Quota-cooldown badges (quota-states §06 + model-flow §02): UNFILTERED —
  // cross-provider cooldowns are exactly what the failover will hit. Keyed
  // 'provider/model'. A cooling model stays selectable (the backend skips it
  // proactively and fails over) but is dimmed and says when it is back.
  const [cooldowns, setCooldowns] = useState<Record<string, CooldownEntry>>({});
  // Per-model request counters since UTC midnight for the quota meters
  // (cost tiers 2026-07-30) — same refresh moments as the cooldowns.
  const [modelsToday, setModelsToday] = useState<Record<string, number>>({});
  const refreshCooldowns = useCallback(() => {
    api.getQuotaCooldowns()
      .then(list => {
        const byKey: Record<string, CooldownEntry> = {};
        for (const c of list) byKey[`${c.provider}/${c.model}`] = { until: c.until, kind: c.kind };
        setCooldowns(byKey);
      })
      .catch(() => { /* badges are best-effort — the menu works without them */ });
    api.getUsageSummary()
      .then(u => setModelsToday(u.modelsToday ?? {}))
      .catch(() => { /* meters are best-effort too */ });
  }, []);
  // Refresh moments: mount + app signal (stream errors), menu open, window
  // focus. Deliberately no interval polling.
  useEffect(() => { refreshCooldowns(); }, [refreshCooldowns, refreshSignal]);
  useEffect(() => { if (open) refreshCooldowns(); }, [open, refreshCooldowns]);
  useEffect(() => {
    const onFocus = () => refreshCooldowns();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshCooldowns]);

  // Live countdown (user request 2026-07-26): re-render once per second
  // while anything time-based is visible so "in 57 s" counts down and
  // badges/pill dot disappear the moment their cooldown expires.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const anyCooldown = Object.keys(cooldowns).length > 0;
  useEffect(() => {
    if (!anyCooldown) return;
    setNowMs(Date.now()); // fresh baseline, not 1 s stale
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyCooldown, open]);

  // Countdown for long cooldowns (daily limits, user decision 2026-07-30 —
  // "wie lange noch?" instead of a clock time), seconds for short ones;
  // retired models never come back — no time, just the label.
  const formatResetCountdown = (remainingMs: number): string => {
    const h = Math.floor(remainingMs / 3_600_000);
    const m = Math.ceil((remainingMs % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const coolBadge = (entry: CooldownEntry): string | null => {
    if (entry.kind === 'retired') return S.noLongerAvailable;
    const remainingMs = new Date(entry.until).getTime() - nowMs;
    if (remainingMs <= 0) return null;
    if (remainingMs > 5 * 60 * 1000) return formatResetCountdown(remainingMs);
    return S.coolingInSeconds(Math.ceil(remainingMs / 1000));
  };

  // Amber pill dot (§03): only when the ACTIVE pair cools — the full story
  // (which models, until when) stays one click away in the menu.
  const activeCoolEntry = cooldowns[`${activeProvider}/${activeModel}`];
  const activeCoolText = activeCoolEntry ? coolBadge(activeCoolEntry) : null;

  return (
    <div ref={rootRef} className="relative shrink-0" data-testid="model-picker-root">
      {/* Narrow chat columns (container queries): the pill shrinks to 8rem
          and hides below 19rem — but ONLY the pill. The menu keeps working
          via openSignal (quota cards' "Modell wechseln"), anchored to this
          root (audit-2 fix: the click used to do visibly nothing). */}
      <button
        data-focus-item="composer-model"
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={activeCoolText ? S.pillCoolingTip(active?.label ?? activeModel, activeCoolText) : S.switchModel(activeModel)}
        data-testid="model-pill"
        className="@max-[19rem]:hidden h-9 max-w-[11rem] @max-[23rem]:max-w-[8rem] px-3 inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 text-[12.5px] font-medium text-gray-500 hover:text-gray-800 transition-colors disabled:opacity-50"
      >
        {activeCoolText && (
          <span data-testid="pill-cooling-dot" className="shrink-0 text-amber-700">
            <Clock size={11} />
          </span>
        )}
        <span className="truncate">{active?.label ?? activeModel}</span>
        <ChevronDown size={13} className="shrink-0" />
      </button>

      <Popover
        open={open}
        anchorRef={rootRef}
        onClose={closeMenu}
        role="menu"
        testId="model-menu"
        className="w-72 rounded-xl border border-gray-200 bg-white shadow-lg p-1.5 text-sm"
      >
        {groups.map((g, gi) => {
          const localDown = Boolean(g.local) && !ollamaReachable;
          return (
            <div key={g.tier ?? g.provider ?? g.label}>
              {gi > 0 && <div className="h-px bg-gray-100 my-1 mx-1" />}
              {/* Tier headers (W2b): green for free, amber for paid — the
                  same families the cooldown badges and footer dot already
                  use in every theme. */}
              <div
                className={`px-2.5 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${
                  g.tier === 'free' ? 'text-green-700' : g.tier === 'paid' ? 'text-amber-700' : g.tier === 'setup' ? 'text-blue-700' : 'text-gray-400'
                }`}
              >
                {g.tier === 'free' && <Check size={10} className="shrink-0" />}
                {g.tier === 'paid' && <CreditCard size={10} className="shrink-0" />}
                {g.tier === 'setup' && <Plus size={10} className="shrink-0" />}
                {g.label}
              </div>
              {/* G3 (§07): the setup group states the free allowance in the
                  unit the provider itself uses and what it buys — nothing
                  is picked here, so no meter and no radio semantics. */}
              {g.tier === 'setup' && g.models.map(m => {
                const provider = rowProvider(g, m);
                const quota =
                  typeof m.requestsPerDay === 'number'
                    ? S.freeQuotaRequestsPerDay(m.requestsPerDay)
                    : typeof m.tokensPerDay === 'number'
                      ? S.freeQuotaTokensPerDay(m.tokensPerDay)
                      : null;
                const subtitle = [quota, S.reserveHint, m.vision === false ? S.noImages : null]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <button
                    key={`setup/${provider}`}
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      if (onSetupProvider) onSetupProvider(provider);
                      else onOpenSettings();
                    }}
                    data-testid={`setup-item-${provider}`}
                    className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-gray-50"
                  >
                    <Zap size={12} className="shrink-0 mt-1 text-blue-700" />
                    <span className="flex-1 min-w-0">
                      <span className="block font-semibold text-[13px] text-gray-900 truncate">
                        {m.label ?? m.name}
                      </span>
                      <span className="block text-[11.5px] text-gray-500">{subtitle}</span>
                    </span>
                    <span className="shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-full border border-blue-100 bg-blue-50 px-1.5 py-px text-[10px] font-semibold text-blue-700 whitespace-nowrap">
                      {S.setupBadge}
                    </span>
                  </button>
                );
              })}
              {g.tier !== 'setup' && g.models.map(m => {
                const provider = rowProvider(g, m);
                const isActive = provider === activeProvider && m.name === activeModel;
                const entry = cooldowns[`${provider}/${m.name}`];
                // Meter chip only where a request quota exists (W8 rule:
                // token-limited models get no counter). A daily cooldown
                // turns the chip into a countdown; other cooldown kinds
                // keep the amber badge.
                const hasQuota = !g.local && typeof m.requestsPerDay === 'number';
                const dailyChip = hasQuota && entry?.kind === 'daily' && coolBadge(entry) !== null;
                const badge = !g.local && entry && !dailyChip ? coolBadge(entry) : null;
                const paid = m.free === false;
                const subtitle = g.local
                  ? (localDown ? S.ollamaNotReachable : hintFor(m))
                  : [m.providerLabel, paid ? S.billingNeeded : null, m.vision === false ? S.noImages : null]
                      .filter(Boolean)
                      .join(' · ') || null;
                const usedToday = modelsToday[`${provider}/${m.name}`] ?? 0;
                return (
                  <button
                    key={`${provider}/${m.name}`}
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={localDown}
                    onClick={() => { onSelectModel(provider, m.name); setOpen(false); }}
                    data-testid={`model-item-${m.name}`}
                    className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-colors disabled:cursor-default ${
                      isActive ? 'bg-blue-50' : localDown ? '' : 'hover:bg-gray-50'
                    }`}
                  >
                    {paid && <Lock size={12} className="shrink-0 mt-1 text-gray-400" />}
                    <span className="flex-1 min-w-0">
                      <span className={`block font-semibold text-[13px] truncate ${badge || localDown || paid ? 'text-gray-400' : 'text-gray-900'}`}>
                        {m.label ?? m.name}
                      </span>
                      {subtitle && <span className="block text-[11.5px] text-gray-500">{subtitle}</span>}
                    </span>
                    {hasQuota && !badge && (
                      <span
                        data-testid={`model-quota-${m.name}`}
                        className={`shrink-0 mt-1 inline-flex items-center gap-1.5 font-mono text-[10px] whitespace-nowrap ${
                          dailyChip ? 'text-red-600' : 'text-gray-400'
                        }`}
                      >
                        <span className="w-8 h-1 rounded-full bg-gray-200 overflow-hidden">
                          <span
                            className={`block h-full rounded-full ${dailyChip ? 'bg-red-500' : 'bg-green-600'}`}
                            style={{ width: `${dailyChip ? 100 : Math.min(100, Math.round((usedToday / (m.requestsPerDay as number)) * 100))}%` }}
                          />
                        </span>
                        {dailyChip ? coolBadge(entry) : `${usedToday}/${m.requestsPerDay}`}
                      </span>
                    )}
                    {badge && (
                      <span
                        data-testid={`model-cooldown-${m.name}`}
                        className="shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[10px] font-semibold text-amber-700 whitespace-nowrap"
                      >
                        <Clock size={9} className="shrink-0" />
                        {badge}
                      </span>
                    )}
                    {isActive && <Check size={14} className="shrink-0 mt-0.5 text-blue-700" />}
                  </button>
                );
              })}
              {/* Local group hints (§02): the private option never just
                  disappears — the row says WHY it is missing and where to
                  fix it. */}
              {g.local && (localDown || g.models.length === 0) && (
                <button
                  role="menuitem"
                  onClick={() => { setOpen(false); onOpenSettings(); }}
                  data-testid="local-hint-row"
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[12px] text-gray-500 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <Info size={13} className="shrink-0 text-gray-400" />
                  {localDown ? S.startOllamaHint : S.installVisionModelHint}
                  <ChevronRight size={13} className="ml-auto text-gray-400" />
                </button>
              )}
            </div>
          );
        })}

        {canThink && (
          <>
            <div className="h-px bg-gray-100 my-1 mx-1" />
            <button
              role="menuitemcheckbox"
              aria-checked={think}
              onClick={onToggleThink}
              data-testid="thinking-row"
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left font-medium text-gray-800 hover:bg-gray-50 transition-colors"
            >
              <Lightbulb size={14} className="text-gray-500 shrink-0" />
              {S.thinking}
              <span className="ml-auto text-gray-500 font-normal text-[12.5px]">
                {think ? S.on : S.off}
              </span>
            </button>
          </>
        )}

        <div className="h-px bg-gray-100 my-1 mx-1" />
        <button
          role="menuitem"
          onClick={() => { setOpen(false); onOpenSettings(); }}
          data-testid="manage-models-row"
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left font-medium text-gray-800 hover:bg-gray-50 transition-colors"
        >
          {S.manageModels}
          <ChevronRight size={14} className="ml-auto text-gray-400" />
        </button>

        {/* Footer honesty (§02): the dot belongs to Ollama reachability
            ONLY — the app cannot know a cloud provider is up, so the
            cloud gets a neutral count, never a fake green dot. */}
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[11px] text-gray-500" data-testid="picker-provider-status">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ollamaReachable && localGroupModels.length > 0 ? 'bg-green-500' : 'bg-gray-300'}`} />
          <span className="truncate">
            {!ollamaReachable
              ? S.ollamaNotReachable
              : localGroupModels.length === 0
                ? S.ollamaNoVisionModel
                : S.ollamaRunningShort}
            {' · '}
            {S.cloudProvidersCount(cloudCount)}
            {freeProvidersTotal > 0 && ` · ${S.freeProvidersCount(freeProvidersReady, freeProvidersTotal)}`}
          </span>
        </div>
      </Popover>
    </div>
  );
}
