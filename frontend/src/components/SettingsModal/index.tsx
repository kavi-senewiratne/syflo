/**
 * components/SettingsModal/index.tsx
 *
 * Modal for switching between the five chat providers (ADR-0008): four
 * cloud providers under the user's own key + the local Ollama. Loads the
 * current settings on open, sends only changed fields on save. API keys are
 * held only in local useState — they are never read back from the backend.
 *
 * Layout: tabs (design/mockup-settings-reorg.html, variant A) — i.a.
 * "Appearance" (themes, instant, footer only Close) and "Model" (numbered
 * flow: 1 Provider, 2 Model, 3 API Key for cloud providers; only here is
 * the Activate button). Model shortlists, key URLs and prices come from
 * the registry (GET /settings/registry).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { X, Loader2, Eye, EyeOff, Check, ExternalLink, Info, RefreshCw, Palette, Cpu, ScrollText, Languages, Mic, Search } from 'lucide-react';
import { api } from '../../api';
import { ModelTierList, type TierCooldown } from './ModelTierList';
import { THEMES, applyTheme, getStoredTheme, type ThemeId } from '../../theme';
import { APP_LANGUAGES, setAppLanguage, useAppLanguage } from '../../appLanguage';
import { useStrings } from '../../strings';
import type { CloudProvider, LLMProvider, OllamaModelInfo, Registry, Settings, UsageSummary } from '../../types';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export type SettingsTab = 'appearance' | 'model' | 'search' | 'language' | 'instructions';

// Deckel der Custom instructions — muss mit MAX_CUSTOM_INSTRUCTIONS_CHARS im
// Backend (routes/settings.js) übereinstimmen.
const MAX_INSTRUCTIONS_CHARS = 2000;

interface Props {
  open: boolean;
  onClose: () => void;
  // Called whenever the user successfully activates a new configuration so the
  // rest of the app (e.g. the sidebar status badge) can re-fetch settings.
  onSaved?: (s: Settings) => void;
  // Tab, auf dem das Modal öffnet — die Composer-Pille ("Manage models")
  // springt direkt zum Model-Tab, das Zahnrad öffnet auf Appearance.
  initialTab?: SettingsTab;
  // Provider card to preselect on open (W9 path chooser, 2026-07-30).
  initialProvider?: LLMProvider;
}

// Order of the provider cards in step 1 (ADR-0008): cloud first (Gemini is
// the fresh-install default), the local Ollama last.
const PROVIDER_ORDER: readonly LLMProvider[] = ['gemini', 'groq', 'openai', 'anthropic', 'ollama'];

// Cost fallback while the registry is not (yet) loaded.
const FREE_FALLBACK: Record<LLMProvider, boolean> = {
  ollama: true,
  gemini: true,
  groq: true,
  openai: false,
  anthropic: false,
};

// Nummerierter Schritt-Titel im Model-Tab (Mockup: Kreis-Ziffer + Versalien).
function StepLabel({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 text-white text-[11px] font-semibold leading-none shrink-0">
        {n}
      </span>
      {children}
    </span>
  );
}

export function SettingsModal({ open, onClose, onSaved, initialTab = 'appearance', initialProvider }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  const [provider, setProvider] = useState<LLMProvider>('gemini');
  // One chosen model and one key input PER cloud provider — switching
  // between cards never loses half-typed state this way.
  const [cloudModels, setCloudModels] = useState<Record<CloudProvider, string>>({
    gemini: '', groq: '', openai: '', anthropic: '',
  });
  const [keyInputs, setKeyInputs] = useState<Record<CloudProvider, string>>({
    gemini: '', groq: '', openai: '', anthropic: '',
  });
  const [showKey, setShowKey] = useState(false);
  // The web search key (W3, design/mockup-onboarding-flow.html §06). Its own
  // input rather than a fifth entry in `keyInputs`: Tavily is not an LLM
  // provider, has no model to pick, and is never "activated" — it is one key
  // that either exists or does not.
  const [searchKeyInput, setSearchKeyInput] = useState('');

  // Model registry + usage summary (ADR-0008) — both non-fatal: without
  // the registry the model dropdown falls back to the stored model, without
  // usage only the counter block is missing.
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // Cooldown snapshot for the tier list (exhausted rows show a countdown).
  const [cooldowns, setCooldowns] = useState<Record<string, TierCooldown>>({});

  // Ollama models pulled locally (vision-filtered, with canThink). Loaded
  // once per modal-open; manually refreshable. Frozen fallback (ADR-0008
  // amendment): downloads happen via `ollama pull` in the terminal — the
  // app only lists.
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);

  // Color theme — purely local (localStorage + data-theme attribute), so it
  // applies instantly on click and is independent of the Activate flow below.
  const [theme, setTheme] = useState<ThemeId>(getStoredTheme);
  const chooseTheme = (id: ThemeId) => {
    applyTheme(id);
    setTheme(id);
  };

  // App language (CONTEXT.md, Grill 2026-07-24) — wie das Theme rein lokal
  // und sofort wirksam; der Hook re-rendert das Modal beim Wechsel mit.
  const appLanguage = useAppLanguage();
  const S = useStrings().settings;

  const loadOllamaModels = () => {
    setOllamaModelsLoading(true);
    api.getOllamaModels()
      .then(setOllamaModels)
      .finally(() => setOllamaModelsLoading(false));
  };

  // `original` spiegelt die zuletzt gespeicherten/geladenen Werte. Wir vergleichen
  // damit die aktuellen Form-Werte, um den "Save"-Button nur dann freizugeben,
  // wenn wirklich etwas geändert wurde — und um den "Active"-Status oben zu zeigen.
  const [original, setOriginal] = useState<Settings | null>(null);

  // Custom instructions (CONTEXT.md): Freitext + An/Aus-Switch. Expliziter
  // Save statt Auto-Save — halb getippte Anweisungen dürfen nie in den Prompt
  // gelangen (und würden per KV-Cache alle Chat-Warm-ups entwerten).
  const [instructions, setInstructions] = useState('');
  const [instructionsEnabled, setInstructionsEnabled] = useState(true);

  const applySettings = (s: Settings) => {
    setProvider(s.llm_provider);
    setCloudModels({
      gemini: s.gemini_model,
      groq: s.groq_model,
      openai: s.openai_model,
      anthropic: s.anthropic_model,
    });
    setInstructions(s.custom_instructions);
    setInstructionsEnabled(s.custom_instructions_enabled);
    setOriginal(s);
  };

  // Bei jedem Öffnen frisch laden, damit Wechsel von außerhalb nicht überschrieben werden.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setKeyInputs({ gemini: '', groq: '', openai: '', anthropic: '' });
    setSearchKeyInput('');
    setShowKey(false);
    setTab(initialTab);
    setLoading(true);
    api.getSettings()
      .then(s => {
        applySettings(s);
        // The W9 path chooser lands on its matching provider card — the
        // saved provider stays untouched until Activate.
        if (initialProvider) setProvider(initialProvider);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
    loadOllamaModels();
    // Fetch registry + usage non-fatally (ADR-0008). Cooldowns feed the
    // tier list's exhausted state — fetch-on-open is enough (2026-07-30),
    // only the countdown ticks client-side.
    api.getRegistry().then(setRegistry).catch(() => {});
    api.getUsageSummary().then(setUsage).catch(() => {});
    api.getQuotaCooldowns?.()
      .then(list => {
        const byKey: Record<string, TierCooldown> = {};
        for (const c of list) byKey[`${c.provider}/${c.model}`] = { until: c.until, kind: c.kind };
        setCooldowns(byKey);
      })
      .catch(() => {});
  }, [open, initialTab]);

  // Whether a key for cloud provider p is already stored in the backend.
  const keySetFor = (p: CloudProvider): boolean =>
    Boolean(original?.[`${p}_api_key_set`]);

  // "Dirty" = the selection differs from the last saved values. A non-empty
  // key input also counts as dirty (even though we never know the stored
  // key — anything typed is intent). The Ollama model does NOT count here:
  // it is switched only via the composer pill ("one owner per job") —
  // Settings manages provider, cloud models and keys.
  const dirty = useMemo(() => {
    if (!original) return false;
    if (provider !== original.llm_provider) return true;
    if (provider === 'ollama') return false;
    return (
      cloudModels[provider] !== original[`${provider}_model`] ||
      keyInputs[provider].length > 0
    );
  }, [original, provider, cloudModels, keyInputs]);

  // Every cloud provider strictly requires a key. Activation stays blocked
  // while neither a stored nor a typed one exists.
  const needsKey =
    provider !== 'ollama' && !keyInputs[provider] && !keySetFor(provider);
  const canActivate = dirty && !needsKey;

  // Eigener Dirty-Stand für den Instructions-Tab — er hat seinen eigenen
  // Save-Knopf und soll den Model-Activate nicht mit scharf schalten.
  const instructionsDirty = useMemo(() => {
    if (!original) return false;
    return (
      instructions !== original.custom_instructions ||
      instructionsEnabled !== original.custom_instructions_enabled
    );
  }, [original, instructions, instructionsEnabled]);

  // Esc schließt das Modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateSettings>[0] = {
        llm_provider: provider,
      };
      if (provider !== 'ollama') {
        patch[`${provider}_model`] = cloudModels[provider];
        // Only send the key when the user actually typed something (empty
        // string = explicit delete — only "Remove key" sends that).
        if (keyInputs[provider].length > 0) patch[`${provider}_api_key`] = keyInputs[provider];
      }
      const result = await api.updateSettings(patch);
      applySettings(result);   // setzt `original` neu → dirty wird false → Button deaktiviert sich
      setKeyInputs({ gemini: '', groq: '', openai: '', anthropic: '' });
      setSearchKeyInput('');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : S.errors.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveInstructions = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateSettings({
        custom_instructions: instructions,
        custom_instructions_enabled: instructionsEnabled,
      });
      applySettings(result);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : S.errors.saveInstructionsFailed);
    } finally {
      setSaving(false);
    }
  };

  // The search tab's own Save — it sends the key ALONE, never the provider or
  // the model alongside it. A tab that resaves things the reader did not touch
  // is a tab that can undo their last change by accident.
  const handleSaveSearchKey = async () => {
    const key = searchKeyInput.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateSettings({ tavily_api_key: key });
      applySettings(result);
      setSearchKeyInput('');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : S.errors.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  // The one caller allowed to send an empty key: an explicit removal.
  const handleClearSearchKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateSettings({ tavily_api_key: '' });
      applySettings(result);
      setSearchKeyInput('');
      onSaved?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : S.errors.removeKeyFailed);
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async (p: CloudProvider) => {
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof api.updateSettings>[0] = {};
      patch[`${p}_api_key`] = '';
      const result = await api.updateSettings(patch);
      applySettings(result);
      setKeyInputs(prev => ({ ...prev, [p]: '' }));
      onSaved?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : S.errors.removeKeyFailed);
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: typeof Palette }[] = [
    { id: 'appearance', label: S.tabs.appearance, icon: Palette },
    { id: 'model', label: S.tabs.model, icon: Cpu },
    // Right after Model: both answer "where do Syflo's answers come from?".
    { id: 'search', label: S.tabs.search, icon: Search },
    { id: 'language', label: S.tabs.language, icon: Languages },
    { id: 'instructions', label: S.tabs.instructions, icon: ScrollText },
  ];

  return (
    <div
      data-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        // role="dialog": the keyboard navigation treats an open dialog as a
        // takeover region — the ring walks its controls like a menu's
        // (user request 2026-09-12); also the correct a11y semantics.
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">{S.title}</h3>
          <button
            onClick={onClose}
            aria-label={S.close}
            className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body: linke Tab-Leiste + Tab-Inhalt. FESTE Höhe, damit das Modal
            beim Tab-Wechsel nicht springt (Nutzerkorrektur 2026-07-22) —
            längere Tab-Inhalte scrollen intern. Auf kleinen Fenstern deckelt
            max-h; das Mockup gibt min. 356px fürs Tab-Raster vor. */}
        <div className="flex items-stretch h-[480px] max-h-[calc(100vh-10rem)]" data-testid="settings-body">
          {/* Auto-Breite statt festem w-40: "Erscheinungsbild" (DE) läuft sonst
              in den breiten Theme-Fonts über (Matrix-Mono: 168px Textbedarf) —
              Nutzerreport 2026-07-24, alle Themes betroffen. min/max begrenzen,
              truncate am Label fängt den Rest ab. */}
          {/* data-keyboard-rail: the keyboard navigation treats this tab list
              as its own column — ↑/↓ walk the tabs, → crosses into the tab's
              page (user request 2026-09-12). */}
          <nav data-keyboard-rail className="shrink-0 min-w-40 max-w-56 border-r border-gray-100 bg-gray-50/50 p-2 space-y-1" aria-label={S.sectionsAria}>
            {tabs.map(t => {
              const isActive = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  aria-current={isActive ? 'page' : undefined}
                  // The ring enters the dialog on the ACTIVE tab — the same
                  // "here you are" convention the sidebar's open chat row uses.
                  data-focus-active={isActive ? 'true' : undefined}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                    isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="min-w-0 truncate" title={t.label}>{t.label}</span>
                  {/* Grüner Punkt am Model-Tab: hier lebt das aktive Modell */}
                  {t.id === 'model' && original && (
                    <span
                      className="ml-auto w-1.5 h-1.5 rounded-full bg-green-500 shrink-0"
                      title={S.activeModelDot}
                    />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 px-5 py-5 space-y-5 min-w-0 overflow-y-auto">
            {loading ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm py-6 justify-center">
                <Loader2 size={14} className="animate-spin" />
                <span>{S.loading}</span>
              </div>
            ) : (
              <>
                {tab === 'appearance' ? (
                  /* Theme-Auswahl — wirkt sofort, kein "Activate" nötig */
                  <div>
                    <label className="block text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">
                      {S.appearance.theme}
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {THEMES.filter(t => !t.hidden).map(t => {
                        const isSelected = theme === t.id;
                        return (
                          <button
                            key={t.id}
                            onClick={() => chooseTheme(t.id)}
                            title={t.label}
                            className={`inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                              isSelected
                                ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                                : 'bg-gray-50 text-gray-700 ring-1 ring-gray-200 hover:bg-gray-100'
                            }`}
                          >
                            <span className="flex gap-1" aria-hidden="true">
                              {t.swatches.map((c, i) => (
                                <span
                                  key={i}
                                  className="w-2.5 h-2.5 rounded-full ring-1 ring-black/10"
                                  style={{ background: c }}
                                />
                              ))}
                            </span>
                            {t.label}
                            {isSelected && <Check size={12} className="shrink-0" />}
                          </button>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                      {S.appearance.note}
                    </p>
                  </div>
                ) : tab === 'language' ? (
                  /* App language (mockup-settings-reorg.html, Variante A · State 5):
                     wirkt sofort wie Themes — kein Activate. Labels stehen immer in
                     ihrer eigenen Sprache (nie übersetzen), damit man aus einer
                     versehentlich gewählten Sprache zurückfindet. */
                  <>
                    <div>
                      <label className="flex items-center gap-2 text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">
                        <Languages size={13} className="text-gray-400 shrink-0" />
                        {S.language.appLanguage}
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {APP_LANGUAGES.map(l => {
                          const isSelected = appLanguage === l.id;
                          return (
                            <button
                              key={l.id}
                              onClick={() => setAppLanguage(l.id)}
                              aria-pressed={isSelected}
                              className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left flex items-center justify-between ${
                                isSelected
                                  ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                              }`}
                            >
                              {l.label}
                              {isSelected && <Check size={12} className="shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                        {S.language.note}
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center gap-2 text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">
                        <Info size={13} className="text-gray-400 shrink-0" />
                        {S.language.howTitle}
                      </div>
                      <p className="text-[11px] text-gray-500 leading-relaxed">
                        {S.language.howNote}
                      </p>
                    </div>

                    {/* Diktat: bewusst read-only — Auto-Detect ist per ADR-0004
                        festgelegt, hier gibt es nichts zu konfigurieren. */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                          <Mic size={13} className="text-gray-400 shrink-0" />
                          {S.language.dictation}
                        </div>
                        <span className="text-[11px] font-medium text-gray-600 bg-gray-100 rounded-full px-2 py-0.5">
                          {S.language.dictationBadge}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-500 leading-relaxed">
                        {S.language.dictationNote}
                      </p>
                    </div>
                  </>
                ) : tab === 'instructions' ? (
                  /* Custom instructions (mockup-settings-reorg.html, Variante A ·
                     State 4): Freitext + An/Aus-Switch, Save unten im Footer. */
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label
                        htmlFor="custom-instructions"
                        className="flex items-center gap-2 text-xs font-semibold text-gray-700 uppercase tracking-wider"
                      >
                        <ScrollText size={13} className="text-gray-400 shrink-0" />
                        {S.instructions.label}
                      </label>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={instructionsEnabled}
                        aria-label={S.instructions.switchAria}
                        title={instructionsEnabled ? S.instructions.switchOnTitle : S.instructions.switchOffTitle}
                        onClick={() => setInstructionsEnabled(v => !v)}
                        className={`relative w-[30px] h-[18px] rounded-full transition-colors shrink-0 ${
                          instructionsEnabled ? 'bg-blue-600' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all ${
                            instructionsEnabled ? 'left-[14px]' : 'left-0.5'
                          }`}
                        />
                      </button>
                    </div>
                    <textarea
                      id="custom-instructions"
                      value={instructions}
                      onChange={e => setInstructions(e.target.value)}
                      maxLength={MAX_INSTRUCTIONS_CHARS}
                      rows={5}
                      placeholder={S.instructions.placeholder}
                      className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm leading-relaxed focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition resize-y"
                    />
                    <div className="mt-1 text-[11px] text-gray-400 text-right font-mono">
                      {instructions.length} / {MAX_INSTRUCTIONS_CHARS}
                    </div>
                    <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
                      {S.instructions.note}
                    </p>
                  </div>
                ) : tab === 'search' ? (
                  /* W3 (design/mockup-onboarding-flow.html §06) as a tab of
                     its own (user decision 2026-08-24). It was first built as
                     a row under the model steps, which was wrong twice over:
                     the search belongs to no provider, and it is never
                     "activated" — so it does not share the model tab's
                     Activate button either. Like Instructions, it has its own
                     Save. The mockup's second option ("own SearXNG") is gone
                     with ADR-0012: Tavily is the whole of it. */
                  <div data-testid="settings-search-row" className="space-y-3">
                    <p className="flex items-center gap-2 text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      <Search size={13} className="shrink-0 text-gray-400" />
                      {S.search.label}
                    </p>
                    {/* Variant C of mockup-search-settings-key-states.html
                        (user decisions 2026-09-12): the sell lives in a guide
                        block that renders only while nothing is stored, like
                        the Model tab's `key-guide`. Stored → NO input at all:
                        the fingerprint chip is the whole display, and the only
                        exit is Remove — replacing means remove first, then add
                        (user decision 2026-09-12; an editable "replace" field
                        next to a stored key kept reading as "no key here"). */}
                    <div>
                      {/* The badge rides the FIELD label, exactly where the
                          Model tab's key step wears it, and it is the SAME
                          string (`model.keySaved` — just "saved"): "Tavily API
                          key" already says key, so the badge must not repeat
                          it (user report 2026-09-12). Sibling of the label,
                          never a child of an `.uppercase` element — the themes
                          restyle those with their display font. No check icon:
                          the text already says saved. */}
                      <div className="mb-1 flex items-center gap-2">
                        <label
                          htmlFor="settings-tavily-key"
                          className="text-[11px] font-medium text-gray-600"
                        >
                          {S.search.keyLabel}
                        </label>
                        {original?.tavily_api_key_set && (
                          <span className="inline-flex items-center text-[10px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                            {S.model.keySaved}
                          </span>
                        )}
                      </div>
                      {original?.tavily_api_key_set ? (
                        <>
                          <div className="flex gap-2 items-center">
                            {/* The chip proves WHICH key is stored (the hint);
                                a key too short for a safe fingerprint shows
                                generic dots — still "a key is here". No icon:
                                the check lives in the label badge, as on the
                                Model tab (user report 2026-09-12). */}
                            <span
                              data-testid="settings-search-key-chip"
                              className="flex-1 min-w-0 inline-flex items-center px-3 py-2 rounded-lg bg-gray-100 font-mono text-sm text-gray-700"
                            >
                              <span className="truncate">
                                {original.tavily_api_key_hint ?? S.search.keyMasked}
                              </span>
                            </span>
                            <button
                              onClick={handleClearSearchKey}
                              disabled={saving}
                              data-testid="settings-search-remove"
                              className="px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                            >
                              {S.search.removeKey}
                            </button>
                          </div>
                          {/* A plan fact, not a pitch — the reader budgets
                              their searches against it, key or no key (user
                              decision 2026-09-12). Info mark: the app's hint
                              vocabulary. */}
                          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-gray-500 leading-relaxed">
                            <Info size={13} className="mt-0.5 shrink-0 text-gray-400" />
                            {S.search.storedAllowance}
                          </p>
                        </>
                      ) : (
                        <input
                          id="settings-tavily-key"
                          data-testid="settings-search-key-input"
                          type="password"
                          value={searchKeyInput}
                          onChange={e => setSearchKeyInput(e.target.value)}
                          placeholder={S.search.keyPlaceholder}
                          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                        />
                      )}
                    </div>
                    {!original?.tavily_api_key_set && (
                      <div
                        data-testid="search-key-guide"
                        className="rounded-lg bg-blue-50/60 border border-blue-100 p-3.5"
                      >
                        <div className="flex items-start gap-2">
                          <Info size={14} className="text-blue-600 mt-0.5 shrink-0" />
                          <div className="text-xs text-gray-700">
                            <p className="font-semibold text-gray-900 mb-1">{S.search.guideTitle}</p>
                            <p className="leading-relaxed">{S.search.guideBody}</p>
                            <a
                              href="https://app.tavily.com/home"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-2 text-[11px] font-medium text-blue-700 hover:underline inline-flex items-center gap-0.5"
                            >
                              {S.search.getKey}
                              <ExternalLink size={10} />
                            </a>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Step 1: provider — five cards (ADR-0008), cloud
                        first, the local Ollama last. Below the grid: the
                        data-fate line of the SELECTED provider. */}
                    <div>
                      <div className="mb-2"><StepLabel n={1}>{S.model.stepProvider}</StepLabel></div>
                      <div className="grid grid-cols-2 gap-2">
                        {PROVIDER_ORDER.map(p => {
                          const isSelected = provider === p;
                          // "Currently active" = was gerade tatsächlich von Syflo
                          // verwendet wird (zuletzt gespeichert). Kann sich vom
                          // gerade ausgewählten Form-Wert unterscheiden, solange
                          // der User noch nicht "Activate" geklickt hat.
                          const isCurrentlyActive = original?.llm_provider === p;
                          const label = S.model.providerLabels[p];
                          // Kein Kosten-Badge mehr auf der Provider-Karte
                          // (Variante B, 2026-07-30): Kosten sind eine
                          // Eigenschaft von Modell × Key — die Wahrheit
                          // steht in den Tier-Gruppen von Schritt 2. Die
                          // Karte trägt nur noch die Herkunft.
                          const originHint = p === 'ollama' ? S.model.originLocal : S.model.originCloud;
                          return (
                            <button
                              key={p}
                              onClick={() => setProvider(p)}
                              aria-pressed={isSelected}
                              data-testid={`provider-card-${p}`}
                              className={`relative px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                                isSelected
                                  ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100'
                              }`}
                            >
                              {isCurrentlyActive && (
                                <span
                                  className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-green-700"
                                  title={S.model.activeTitle}
                                >
                                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                  {S.model.activeBadge}
                                </span>
                              )}
                              <div>{label}</div>
                              <div className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded text-gray-600 bg-gray-100">
                                {originHint}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {/* Data fate of the selected provider (grill Q13) */}
                      <p className="mt-2 text-[11px] text-gray-500 leading-relaxed" data-testid="provider-data-note">
                        {S.model.dataNotes[provider]}
                      </p>
                    </div>

                    {/* Steps 2 + 3: model and API key of the selected cloud
                        provider (ADR-0008) — or the Ollama model list. */}
                    {provider !== 'ollama' ? (
                      <>
                        <div>
                          <div className="mb-2"><StepLabel n={2}>{S.model.stepModel}</StepLabel></div>
                          {(registry?.providers[provider]?.models.length ?? 0) > 0 ? (
                            // Cost-tier radio list (mockup-model-cost-tiers
                            // Variante B, chosen 2026-07-30) — the tier is a
                            // property of model × key, not of the provider.
                            <ModelTierList
                              provider={provider}
                              models={registry!.providers[provider].models}
                              value={cloudModels[provider]}
                              onChange={name => setCloudModels(prev => ({ ...prev, [provider]: name }))}
                              keySet={keySetFor(provider)}
                              modelsToday={usage?.modelsToday ?? {}}
                              cooldowns={cooldowns}
                            />
                          ) : (
                            // Registry not there (yet): the stored model as
                            // a static row so nothing flips.
                            <div
                              data-testid="cloud-model-list"
                              className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-500"
                            >
                              {cloudModels[provider]}
                            </div>
                          )}
                        </div>

                        {/* Step 3: API key — bound per provider */}
                        <div>
                          {/* Badge as a SIBLING of the StepLabel, not inside
                              it: the themes restyle `.uppercase` with their
                              display font and the badge inherited it. No check
                              icon — the text already says saved (user report
                              2026-09-12, same pass as the search tab). */}
                          <div className="mb-2 flex items-center gap-2">
                            <StepLabel n={3}>{S.model.stepApiKey}</StepLabel>
                            {keySetFor(provider) && (
                              <span className="inline-flex items-center text-[10px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded">
                                {S.model.keySaved}
                              </span>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <input
                                type={showKey ? 'text' : 'password'}
                                value={keyInputs[provider]}
                                onChange={e => {
                                  const value = e.target.value;
                                  setKeyInputs(prev => ({ ...prev, [provider]: value }));
                                }}
                                placeholder={keySetFor(provider) ? S.model.keyPlaceholderSet : S.model.keyPlaceholderEmpty}
                                className="w-full px-3 py-2 pr-9 rounded-lg border border-gray-200 text-sm font-mono focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                              />
                              {/* The eye can only reveal what is being typed RIGHT NOW —
                                  a saved key is never sent back to the frontend, so with
                                  an empty field there is nothing to show and the button
                                  would look broken (user report 2026-07-25). */}
                              {keyInputs[provider] ? (
                                <button
                                  type="button"
                                  onClick={() => setShowKey(s => !s)}
                                  aria-label={showKey ? S.model.keyHide : S.model.keyShow}
                                  data-tip={showKey ? S.model.keyHide : S.model.keyShow}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
                                >
                                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                              ) : null}
                            </div>
                            {keySetFor(provider) && (
                              <button
                                onClick={() => handleClearKey(provider)}
                                disabled={saving}
                                className="px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                              >
                                {S.model.keyRemove}
                              </button>
                            )}
                          </div>
                          <p className="mt-1.5 text-[11px] text-gray-500 leading-relaxed">
                            {S.model.keyNote}
                          </p>
                        </div>

                        {/* Guide block — only while no key is stored yet.
                            Title/body per provider; the link URL comes from
                            the registry (keyUrl), not from the strings. */}
                        {!keySetFor(provider) && (
                          <div className="rounded-lg bg-blue-50/60 border border-blue-100 p-3.5 space-y-3" data-testid="key-guide">
                            <div className="flex items-start gap-2">
                              <Info size={14} className="text-blue-600 mt-0.5 shrink-0" />
                              <div className="text-xs text-gray-700">
                                <p className="font-semibold text-gray-900 mb-1">{S.model.keyGuides[provider].title}</p>
                                <p className="leading-relaxed">
                                  {S.model.keyGuides[provider].body}
                                </p>
                              </div>
                            </div>

                            {registry?.providers[provider]?.keyUrl && (
                              <a
                                href={registry.providers[provider].keyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid="key-guide-cta"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                              >
                                {S.model.guideCta}
                                <ExternalLink size={11} />
                              </a>
                            )}

                            {/* The $-table only applies to the OpenAI starter balance. */}
                            {provider === 'openai' && (
                              <div className="border-t border-blue-100 pt-2.5 text-[11px] text-gray-600 leading-relaxed">
                                <p className="font-semibold text-gray-800 mb-1.5">{S.model.guideWhat}</p>
                                <div className="space-y-1">
                                  <div className="flex items-baseline justify-between">
                                    <span className="text-gray-700">gpt-4o-mini</span>
                                    <span className="font-semibold text-gray-900">{S.model.guideMiniMessages}</span>
                                  </div>
                                  <div className="flex items-baseline justify-between">
                                    <span className="text-gray-700">gpt-4o</span>
                                    <span className="font-semibold text-gray-900">{S.model.guide4oMessages}</span>
                                  </div>
                                </div>
                                <a
                                  href="https://openai.com/api/pricing/"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="mt-2 inline-flex items-center gap-1 text-blue-700 hover:underline"
                                >
                                  {S.model.guidePricing}
                                  <ExternalLink size={10} />
                                </a>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Usage block (ADR-0008): quota counter for free
                            tiers, estimated costs for paid providers. */}
                        {usage && (
                          <div className="rounded-lg border border-gray-200 px-3 py-2.5 text-[11px] text-gray-600 leading-relaxed" data-testid="usage-block">
                            <p className="font-semibold text-gray-700 uppercase tracking-wider text-[10px] mb-1">
                              {S.model.usageTitle}
                            </p>
                            <p>
                              {S.model.usageRequestsToday(
                                usage.providers[provider]?.requestsToday ?? 0,
                                registry?.providers[provider]?.models.find(m => m.name === cloudModels[provider])
                                  ?.freeQuota?.requestsPerDay,
                              )}
                            </p>
                            {!(registry?.providers[provider]?.free ?? FREE_FALLBACK[provider]) && (
                              <p className="font-medium text-gray-700">
                                {S.model.usageEstimate((usage.providers[provider]?.estimatedUsd ?? 0).toFixed(2))}
                              </p>
                            )}
                            <p className="mt-0.5 text-[10px] text-gray-400">
                              {S.model.usagePricesAsOf(usage.pricesAsOf)}
                            </p>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        {/* The list of installed vision models. Frozen
                            fallback (ADR-0008 amendment): no download, no
                            remove, no hardware recommendation — installing
                            happens with `ollama pull` in the terminal.
                            Switching lives in the composer pill; here there is
                            only a passive "Active" badge. */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <StepLabel n={2}>{S.model.stepModels}</StepLabel>
                            <button
                              type="button"
                              onClick={loadOllamaModels}
                              disabled={ollamaModelsLoading}
                              data-tip={S.model.refreshList}
                              aria-label={S.model.refreshList}
                              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                            >
                              <RefreshCw size={12} className={ollamaModelsLoading ? 'animate-spin' : ''} />
                            </button>
                          </div>

                          <div className="space-y-2">
                            {ollamaModels.map(row => {
                              const isActive = original?.ollama_model === row.name;
                              return (
                                <div
                                  key={row.name}
                                  className="flex items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5"
                                  data-testid={`library-row-${row.name}`}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-mono font-medium text-gray-900 truncate">{row.name}</div>
                                    <div className="text-[11px] text-gray-500">
                                      {[row.parameter_size, row.size ? formatSize(row.size) : null].filter(Boolean).join(' · ') || S.model.rowInstalled}
                                      {row.canThink ? S.model.rowCanThink : ''}
                                    </div>
                                  </div>
                                  {isActive && (
                                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">
                                      {S.model.activeBadge}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                            {ollamaModels.length === 0 && (
                              <p className="text-[11px] text-amber-700 leading-relaxed">
                                {S.model.ollamaUnreachable}
                              </p>
                            )}
                          </div>

                          {/* Installing happens in the terminal (frozen fallback). */}
                          <p className="mt-2 text-[11px] text-gray-500 leading-relaxed" data-testid="pull-hint">
                            {S.model.pullHint}
                          </p>
                          <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">
                            {S.model.libraryNote}{' '}
                            <a
                              href="https://ollama.com/download"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-green-700 font-medium hover:underline inline-flex items-center gap-0.5"
                            >
                              {S.model.installOllama}
                              <ExternalLink size={10} />
                            </a>
                          </p>
                        </div>
                      </>
                    )}
                  </>
                )}

                {error && (
                  <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg border border-red-100">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Footer — Activate (und der Status-Hinweis dazu) nur auf dem
            Model-Tab; Appearance hat nur Close, Themes wirken sofort. */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-gray-50 border-t border-gray-100">
          {tab === 'model' && (
            <div className="mr-auto text-xs flex items-center gap-1.5">
              {savedFlash ? (
                <span className="text-green-700 font-medium">
                  {S.footer.activated}
                </span>
              ) : needsKey ? (
                <span className="text-amber-700 font-medium">
                  {S.footer.needsKey(S.model.providerLabels[provider])}
                </span>
              ) : dirty ? (
                <span className="text-amber-700 font-medium">
                  {S.footer.clickActivate}
                </span>
              ) : original ? (
                <span className="text-gray-500 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  {S.footer.selectionActive}
                </span>
              ) : null}
            </div>
          )}
          {tab === 'instructions' && (
            <div className="mr-auto text-xs flex items-center gap-1.5">
              {savedFlash ? (
                <span className="text-green-700 font-medium">
                  {S.footer.saved}
                </span>
              ) : instructionsDirty ? (
                <span className="text-amber-700 font-medium">
                  {S.footer.clickSave}
                </span>
              ) : original ? (
                instructionsEnabled ? (
                  <span className="text-gray-500 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    {S.footer.instructionsOn}
                  </span>
                ) : (
                  <span className="text-gray-500">{S.footer.instructionsOff}</span>
                )
              ) : null}
            </div>
          )}
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
          >
            {S.close}
          </button>
          {tab === 'instructions' && (
            <button
              onClick={handleSaveInstructions}
              disabled={saving || loading || !instructionsDirty}
              title={instructionsDirty ? S.footer.saveTitleDirty : S.footer.saveTitleClean}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? S.footer.saving : S.footer.save}
            </button>
          )}
          {tab === 'search' && (
            <button
              onClick={handleSaveSearchKey}
              // Empty means "leave it alone", so there is nothing to save —
              // clearing a stored key is the Remove button's job, not this
              // one's.
              disabled={saving || loading || searchKeyInput.trim().length === 0}
              data-testid="settings-search-save"
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? S.footer.saving : S.footer.save}
            </button>
          )}
          {tab === 'model' && (
            <button
              onClick={handleSave}
              disabled={saving || loading || !canActivate}
              title={
                needsKey
                  ? S.footer.activateTitleNeedsKey(S.model.providerLabels[provider])
                  : !dirty && !saving
                    ? S.footer.activateTitleClean
                    : S.footer.activateTitleDirty
              }
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? S.footer.activating : S.footer.activate}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
