/**
 * components/ChatArea/ModelPicker.tsx
 *
 * The model pill at the bottom right of the composer + its grouped drop-up
 * menu (design/mockup-model-flow.html §02–§04). Groups say what is usable
 * NOW, what is not, what is still to set up and what runs locally
 * (mockup-onboarding-flow §02, chosen 2026-08-15) — selecting any row
 * switches provider AND model in one click. State badges span all providers
 * (unfiltered /api/quota-cooldowns); the footer is honest about Ollama's
 * state; the menu renders independently of the pill's visibility so the
 * quota cards' "Modell wechseln" works in narrow columns too.
 *
 * The one rule the whole file hangs on: nothing here ever declares a model
 * usable because time passed. Only a delivered answer does that, and only
 * the backend can see it — so an expired wait shows as "status unknown"
 * (user complaint 2026-08-15: "Countdown vorbei, Limit trotzdem erschöpft").
 *
 * The menu itself goes through <Popover> (design/mockup-model-picker-truth
 * §01, variant A): as an `absolute` child of the composer the 288 px panel
 * was cut off by the chat pane's `overflow-hidden` as soon as the column
 * got narrower than the panel — the user's screenshot showed a menu with no
 * left half. The panel keeps its own look; only position moved out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleHelp, Clock, Info, Lightbulb, Lock, Plus, Zap } from 'lucide-react';
import { api } from '../../api';
import { Popover } from '../Popover';
import { splitByAvailability } from '../../chat/pickerGroups';
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
  // Groups mix providers: cloud rows carry their own provider, and the
  // subline names it (provider · cost · image ability, §02).
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

// One group in the drop-up. AVAILABILITY is the grouping axis since §02
// (chosen 2026-08-15) — cost moved onto the row, because "free" and "paid"
// said nothing about whether a model would answer right now:
//   'usable'      — nothing known to be in the way
//   'unavailable' — a wait, an unknown state or a retired model
//   'setup'       — never set up; the one group whose rows are not selectable
//                   (G3, mockup-onboarding-flow §07)
//   'local'       — always last, always present (the private option)
// 'usable' rows arrive in one bundle from buildPickerGroups and are split off
// into 'unavailable' by splitByAvailability, which needs the live cooldowns.
export interface PickerGroup {
  tier?: 'usable' | 'unavailable' | 'local' | 'setup';
  // Group-level provider: only the local group has one; cloud rows carry
  // their provider per model.
  provider?: LLMProvider;
  // The two availability groups are named by the picker itself (it owns the
  // split), so only 'setup' and 'local' carry a label from the caller.
  label?: string;
  local?: boolean;
  models: PickerModel[];
}

interface CooldownEntry {
  until: string;
  // 'daily' | 'minute' | 'retired' | 'unknown' (backend routes/messages.js).
  // 'unknown' is what an expired wait decays into: the clock ran out, but no
  // call was made since, so nothing is actually known about the model.
  kind?: string;
}

// The moment a daily limit is back, as a clock time in the READER's timezone.
// Gemini resets at Pacific midnight, which lands somewhere in the European
// evening — a raw remaining time ("6h 12m") was a number nobody could plan
// around, so §02 asks for the local wall-clock time instead.
const localResetTime = (until: string): string =>
  new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

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

  // Groups mix providers — the active model is found by its row provider
  // (m.provider for cloud rows, the group's for the local one).
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
  const distinctProviders = (...tiers: PickerGroup['tier'][]) =>
    new Set(
      groups
        .filter(g => tiers.includes(g.tier))
        .flatMap(g => g.models)
        .filter(m => m.free !== false)
        .map(m => m.provider)
        .filter(Boolean),
    ).size;
  // "Set up" is about the KEY, not about today's quota: a provider whose
  // free model is cooling down is still set up, so the count reads the
  // groups before the availability split (§02).
  const freeProvidersReady = distinctProviders('usable', 'unavailable');
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
  // Only a running clock needs the ticking. Since §02 an expired entry STAYS
  // in the memory as 'unknown' (that is the whole point), and a retired one
  // has no clock either — without this filter the picker would re-render once
  // a second forever after the first exhausted quota of the session.
  const anyTicking = Object.values(cooldowns).some(
    e => e.kind !== 'unknown' && e.kind !== 'retired' && new Date(e.until).getTime() > nowMs,
  );
  useEffect(() => {
    if (!anyTicking) return;
    setNowMs(Date.now()); // fresh baseline, not 1 s stale
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyTicking, open]);

  // One word per state (mockup-onboarding-flow §02, chosen 2026-08-15). Every
  // entry in the quota memory means "not usable right now" — the four states
  // differ only in WHY, and 'unknown' is the one that was missing.
  //
  // A wait whose clock has run out decays into 'unknown' HERE as well, by the
  // same rule the backend applies to its own memory: the row must not turn
  // green just because a timer reached zero (user complaint "Countdown vorbei,
  // Limit trotzdem erschöpft"). Only a real answer clears the entry, and that
  // happens on the server.
  type ModelState = 'cooling' | 'daily' | 'retired' | 'unknown';
  const stateOf = (entry: CooldownEntry): ModelState => {
    if (entry.kind === 'retired') return 'retired';
    if (entry.kind === 'unknown') return 'unknown';
    if (new Date(entry.until).getTime() - nowMs <= 0) return 'unknown';
    return entry.kind === 'daily' ? 'daily' : 'cooling';
  };
  const stateLabel = (entry: CooldownEntry): string => {
    switch (stateOf(entry)) {
      case 'retired': return S.noLongerAvailable;
      case 'unknown': return S.statusUnknown;
      // A daily limit names the clock time it is back, in the reader's own
      // timezone — a bare "6h 12m" was a countdown to nothing the user could
      // plan around (user decision 2026-08-15, replacing the 2026-07-30 shape).
      case 'daily': return S.dailyLimitLabel(localResetTime(entry.until));
      default: return S.coolingInSeconds(Math.ceil((new Date(entry.until).getTime() - nowMs) / 1000));
    }
  };
  // The badge's color family follows the state: gray means "we do not know",
  // amber means "there is a wait to sit out" (design/ui-vocabulary.md badges).
  const badgeClasses = (entry: CooldownEntry): string =>
    stateOf(entry) === 'unknown'
      ? 'border-gray-200 bg-gray-50 text-gray-500'
      : 'border-amber-200 bg-amber-50 text-amber-700';

  // The availability split (§02) happens here and not in buildPickerGroups,
  // because only this component knows the live quota memory. Membership and
  // badge come from the SAME source — a row that carries a state word is a
  // row that cannot be used right now, so group and badge cannot disagree.
  const shownGroups = splitByAvailability(groups, (provider, model) =>
    Boolean(cooldowns[`${provider}/${model}`]),
  );

  // Amber pill dot (§03): only when the ACTIVE pair really has a limit or is
  // gone. An unknown state gets no warning — there is nothing to wait out and
  // nothing to fail over from; the next question settles it.
  const activeCoolEntry = cooldowns[`${activeProvider}/${activeModel}`];
  const activeCoolText =
    activeCoolEntry && stateOf(activeCoolEntry) !== 'unknown' ? stateLabel(activeCoolEntry) : null;

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
        {shownGroups.map((g, gi) => {
          const localDown = Boolean(g.local) && !ollamaReachable;
          return (
            <div key={g.tier ?? g.provider ?? g.label} data-testid={`picker-group-${g.tier ?? 'other'}`}>
              {gi > 0 && <div className="h-px bg-gray-100 my-1 mx-1" />}
              {/* Group headers (§02): green for what works, neutral gray for
                  what does not — the members of the unusable group carry
                  their own colour (amber for a wait, gray for unknown), so a
                  coloured headline would double the alarm. */}
              <div
                className={`px-2.5 pt-1.5 pb-0.5 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${
                  g.tier === 'usable' ? 'text-green-700' : g.tier === 'setup' ? 'text-blue-700' : 'text-gray-400'
                }`}
              >
                {g.tier === 'usable' && <Check size={10} className="shrink-0" />}
                {g.tier === 'unavailable' && <Clock size={10} className="shrink-0" />}
                {g.tier === 'setup' && <Plus size={10} className="shrink-0" />}
                {g.tier === 'usable' ? S.usableGroup : g.tier === 'unavailable' ? S.unavailableGroup : g.label}
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
                // Meter and state badge are exclusive (§02): a row shows
                // either a live allowance or the reason it cannot be used.
                // The meter itself needs a request-shaped quota (W8 rule:
                // token-limited models get no counter, since nothing here
                // counts tokens).
                const badge = !g.local && entry ? stateLabel(entry) : null;
                const hasQuota = !g.local && !badge && typeof m.requestsPerDay === 'number';
                const paid = m.free === false;
                // Provider · cost · image ability (§02 row copy). The cost
                // tier lost its group and became a word here: "free" and
                // "paid" never answered the question the reader has, which is
                // whether this model will answer right now.
                const subtitle = g.local
                  ? (localDown ? S.ollamaNotReachable : hintFor(m))
                  : [m.providerLabel, paid ? S.paidCostWord : S.freeCostWord, m.vision === false ? S.noImages : null]
                      .filter(Boolean)
                      .join(' · ') || null;
                const usedToday = modelsToday[`${provider}/${m.name}`] ?? 0;
                return (
                  <button
                    key={`${provider}/${m.name}`}
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={localDown}
                    // The one state that needs a sentence: "status unknown"
                    // would otherwise read as a fault. It is not — it says the
                    // app has not looked, and that sending is what looks.
                    title={entry && stateOf(entry) === 'unknown' ? S.statusUnknownTip : undefined}
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
                    {hasQuota && (
                      <span
                        data-testid={`model-quota-${m.name}`}
                        className="shrink-0 mt-1 inline-flex items-center gap-1.5 font-mono text-[10px] whitespace-nowrap text-gray-400"
                      >
                        <span className="w-8 h-1 rounded-full bg-gray-200 overflow-hidden">
                          <span
                            className="block h-full rounded-full bg-green-600"
                            style={{ width: `${Math.min(100, Math.round((usedToday / (m.requestsPerDay as number)) * 100))}%` }}
                          />
                        </span>
                        {`${usedToday}/${m.requestsPerDay}`}
                      </span>
                    )}
                    {badge && (
                      <span
                        data-testid={`model-cooldown-${m.name}`}
                        data-state={stateOf(entry as CooldownEntry)}
                        className={`shrink-0 mt-0.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-semibold whitespace-nowrap ${badgeClasses(entry as CooldownEntry)}`}
                      >
                        {stateOf(entry as CooldownEntry) === 'unknown'
                          ? <CircleHelp size={9} className="shrink-0" />
                          : <Clock size={9} className="shrink-0" />}
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
            {/* One cloud sentence, not two. Measured in the running app: local
                state + cloud count + free count did not fit the 288 px menu and
                truncated mid-word ("2 von…"). The free count is the more useful
                of the two — it names a gap the user can close — so it wins, and
                the generic count only speaks when no free provider exists. */}
            {freeProvidersTotal > 0
              ? S.freeProvidersCount(freeProvidersReady, freeProvidersTotal)
              : S.cloudProvidersCount(cloudCount)}
          </span>
        </div>
      </Popover>
    </div>
  );
}
