/**
 * components/SettingsModal/index.tsx
 *
 * Modal zum Umschalten zwischen lokalem Ollama-Modell und OpenAI-API.
 * Lädt die aktuellen Settings beim Öffnen, schickt nur geänderte Felder
 * beim Speichern zurück. Der API-Key wird im Frontend nur lokal in einem
 * useState gehalten — er wird nicht aus dem Backend zurückgelesen.
 *
 * Layout: zwei Tabs (design/mockup-settings-reorg.html, Variante A) —
 * "Appearance" (Themes, wirken sofort, Footer nur Close) und "Model"
 * (nummerierter Flow: 1 Provider, 2 Model, 3 API Key nur bei OpenAI;
 * nur hier gibt es den Activate-Button).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { X, Loader2, Eye, EyeOff, Check, ExternalLink, Info, RefreshCw, Palette, Cpu, Download, Trash2, MonitorCog, ScrollText, Languages, Mic } from 'lucide-react';
import { api } from '../../api';
import { THEMES, applyTheme, getStoredTheme, type ThemeId } from '../../theme';
import { APP_LANGUAGES, setAppLanguage, useAppLanguage } from '../../appLanguage';
import { useStrings } from '../../strings';
import type { LLMProvider, OllamaModelInfo, Settings, SystemRecommendation } from '../../types';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export type SettingsTab = 'appearance' | 'model' | 'language' | 'instructions';

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
  // Hardware-Empfehlung für diesen Rechner (Banner + "Recommended"-Hinweis
  // in der Bibliothek). null solange unbekannt.
  recommendation?: SystemRecommendation | null;
  // Nach Download/Entfernen eines Modells — der Owner lädt dann Modell-Liste
  // und ggf. Auto-Default neu.
  onLibraryChanged?: () => void;
}

// OpenAI models exposed in the settings dropdown.
// "search-preview" variants have OpenAI's own built-in web search — for those,
// the backend skips its own SearXNG tool-call wiring (see backend/tools.js).
// All four can handle images.
const OPENAI_MODELS = [
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini — small, fast, cheap' },
  { id: 'gpt-4o', label: 'gpt-4o — multimodal, more powerful' },
  { id: 'gpt-4o-mini-search-preview', label: 'gpt-4o-mini-search — built-in web search (no SearXNG)' },
  { id: 'gpt-4o-search-preview', label: 'gpt-4o-search — built-in web search, best quality' },
];

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

export function SettingsModal({ open, onClose, onSaved, initialTab = 'appearance', recommendation, onLibraryChanged }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  const [provider, setProvider] = useState<LLMProvider>('ollama');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o-mini');
  const [keyInput, setKeyInput] = useState('');
  const [keySet, setKeySet] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // Ollama models pulled locally (vision-gefiltert, mit canThink). Loaded once
  // per modal-open; refreshed after downloads/removals and manually.
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);

  // Laufender Modell-Download (Bibliothek): Name + Fortschritt 0..1 (oder
  // null, solange Ollama noch keine Byte-Zahlen liefert).
  const [pulling, setPulling] = useState<{ name: string; fraction: number | null } | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);

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

  // Bibliothekszeilen: installierte Vision-Modelle + (falls noch fehlend)
  // das empfohlene Modell als Download-Zeile obenauf.
  type LibraryRow = OllamaModelInfo & { installed: boolean };
  const libraryRows = useMemo<LibraryRow[]>(() => {
    const rows: LibraryRow[] = ollamaModels.map(m => ({ ...m, installed: true }));
    const rec = recommendation?.recommendedModel;
    if (rec && !rows.some(r => r.name === rec)) {
      rows.unshift({ name: rec, installed: false });
    }
    return rows;
  }, [ollamaModels, recommendation]);

  const handlePull = async (name: string) => {
    setLibraryError(null);
    setPulling({ name, fraction: null });
    try {
      await api.pullOllamaModel(name, p => {
        if (p.total && p.completed !== undefined) {
          setPulling({ name, fraction: p.completed / p.total });
        }
      });
      loadOllamaModels();
      onLibraryChanged?.();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : S.model.downloadFailed);
    } finally {
      setPulling(null);
    }
  };

  const handleRemove = async (name: string) => {
    setLibraryError(null);
    try {
      await api.deleteOllamaModel(name);
      loadOllamaModels();
      onLibraryChanged?.();
    } catch (err) {
      setLibraryError(err instanceof Error ? err.message : S.model.removeFailed);
    }
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
    setOpenaiModel(s.openai_model);
    setKeySet(s.openai_api_key_set);
    setInstructions(s.custom_instructions);
    setInstructionsEnabled(s.custom_instructions_enabled);
    setOriginal(s);
  };

  // Bei jedem Öffnen frisch laden, damit Wechsel von außerhalb nicht überschrieben werden.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setKeyInput('');
    setShowKey(false);
    setTab(initialTab);
    setLoading(true);
    api.getSettings()
      .then(applySettings)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
    loadOllamaModels();
  }, [open, initialTab]);

  // "Dirty" = irgendein Feld weicht von den zuletzt gespeicherten Werten ab.
  // Auch ein nicht-leeres Key-Eingabefeld zählt als dirty (auch wenn wir den
  // gespeicherten Key nicht kennen — jeder eingetippte Wert ist eine Absicht).
  // Das Ollama-Modell zählt hier NICHT mehr mit: gewechselt wird nur über
  // die Composer-Pille ("one owner per job") — Settings verwaltet Provider,
  // OpenAI-Modell, Key und die lokale Bibliothek.
  const dirty = useMemo(() => {
    if (!original) return false;
    return (
      provider !== original.llm_provider ||
      openaiModel !== original.openai_model ||
      keyInput.length > 0
    );
  }, [original, provider, openaiModel, keyInput]);

  // OpenAI braucht zwingend einen Key. Aktivierung wird blockiert, solange
  // weder ein gespeicherter noch ein neu eingegebener Key existiert.
  const needsKey = provider === 'openai' && !keyInput && !original?.openai_api_key_set;
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
        openai_model: openaiModel,
      };
      // Nur senden, wenn der User wirklich was getippt hat (auch leerer String =
      // explizites Löschen, das schicken wir nur, wenn der User auf "Key entfernen" geht).
      if (keyInput.length > 0) patch.openai_api_key = keyInput;

      const result = await api.updateSettings(patch);
      applySettings(result);   // setzt `original` neu → dirty wird false → Button deaktiviert sich
      setKeyInput('');
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

  const handleClearKey = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateSettings({ openai_api_key: '' });
      applySettings(result);
      setKeyInput('');
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
    { id: 'language', label: S.tabs.language, icon: Languages },
    { id: 'instructions', label: S.tabs.instructions, icon: ScrollText },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
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
          <nav className="shrink-0 min-w-40 max-w-56 border-r border-gray-100 bg-gray-50/50 p-2 space-y-1" aria-label="Settings sections">
            {tabs.map(t => {
              const isActive = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  aria-current={isActive ? 'page' : undefined}
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
                ) : (
                  <>
                    {/* Schritt 1: Provider */}
                    <div>
                      <div className="mb-2"><StepLabel n={1}>{S.model.stepProvider}</StepLabel></div>
                      <div className="grid grid-cols-2 gap-2">
                        {(['ollama', 'openai'] as LLMProvider[]).map(p => {
                          const isSelected = provider === p;
                          // "Currently active" = was gerade tatsächlich von Syflo
                          // verwendet wird (zuletzt gespeichert). Kann sich vom
                          // gerade ausgewählten Form-Wert unterscheiden, solange
                          // der User noch nicht "Activate" geklickt hat.
                          const isCurrentlyActive = original?.llm_provider === p;
                          const label = p === 'ollama' ? S.model.ollamaLabel : S.model.openaiLabel;
                          const costHint = p === 'ollama' ? S.model.costFree : S.model.costPaid;
                          // Beide Kosten-Badges in derselben neutralen Grau-Variante,
                          // damit nichts "schreit" — der Text trägt die Info.
                          const costClass = 'text-gray-600 bg-gray-100';
                          return (
                            <button
                              key={p}
                              onClick={() => setProvider(p)}
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
                              <div className={`mt-1 inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${costClass}`}>
                                {costHint}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Schritt 2: Modell des gewählten Providers */}
                    {provider === 'openai' ? (
                      <>
                        <div>
                          <div className="mb-2"><StepLabel n={2}>{S.model.stepModel}</StepLabel></div>
                          <select
                            value={openaiModel}
                            onChange={e => setOpenaiModel(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                          >
                            {OPENAI_MODELS.map(m => (
                              <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                          </select>
                        </div>

                        {/* Schritt 3: API-Key — nur für OpenAI */}
                        <div>
                          <div className="mb-2"><StepLabel n={3}>
                            {S.model.stepApiKey}
                            {keySet && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-green-700 bg-green-50 px-1.5 py-0.5 rounded normal-case tracking-normal">
                                <Check size={10} />
                                {S.model.keySaved}
                              </span>
                            )}
                          </StepLabel></div>
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <input
                                type={showKey ? 'text' : 'password'}
                                value={keyInput}
                                onChange={e => setKeyInput(e.target.value)}
                                placeholder={keySet ? S.model.keyPlaceholderSet : S.model.keyPlaceholderEmpty}
                                className="w-full px-3 py-2 pr-9 rounded-lg border border-gray-200 text-sm font-mono focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 transition"
                              />
                              <button
                                type="button"
                                onClick={() => setShowKey(s => !s)}
                                aria-label={showKey ? S.model.keyHide : S.model.keyShow}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-1"
                              >
                                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                            </div>
                            {keySet && (
                              <button
                                onClick={handleClearKey}
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

                        {/* Guide block — shown only when no key is configured yet.
                            Helps brand-new OpenAI users land on the right page and
                            understand the actual cost (which is tiny for gpt-4o-mini). */}
                        {!keySet && (
                          <div className="rounded-lg bg-blue-50/60 border border-blue-100 p-3.5 space-y-3">
                            <div className="flex items-start gap-2">
                              <Info size={14} className="text-blue-600 mt-0.5 shrink-0" />
                              <div className="text-xs text-gray-700">
                                <p className="font-semibold text-gray-900 mb-1">{S.model.guideTitle}</p>
                                <p className="leading-relaxed">
                                  {S.model.guideBody}
                                </p>
                              </div>
                            </div>

                            <a
                              href="https://platform.openai.com/api-keys"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                            >
                              {S.model.guideCta}
                              <ExternalLink size={11} />
                            </a>

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
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        {/* Die BIBLIOTHEK (mockup-model-picker.html, Sektion 03):
                            Downloads, Fortschritt, Entfernen. Gewechselt wird in
                            der Composer-Pille — hier gibt es keinen Umschalter,
                            nur ein passives "Active"-Abzeichen. */}
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <StepLabel n={2}>{S.model.stepModels}</StepLabel>
                            <button
                              type="button"
                              onClick={loadOllamaModels}
                              disabled={ollamaModelsLoading}
                              title={S.model.refreshList}
                              aria-label={S.model.refreshList}
                              className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                            >
                              <RefreshCw size={12} className={ollamaModelsLoading ? 'animate-spin' : ''} />
                            </button>
                          </div>

                          {recommendation && (
                            <div
                              className="mb-3 flex items-center gap-2 rounded-lg bg-blue-50/60 border border-blue-100 px-3 py-2 text-xs text-gray-700"
                              data-testid="hardware-banner"
                            >
                              <MonitorCog size={14} className="text-blue-600 shrink-0" />
                              <span>
                                {S.model.machineBanner(recommendation.totalMemGb)}{' '}
                                <span className="font-semibold font-mono">{recommendation.recommendedModel}</span>
                              </span>
                            </div>
                          )}

                          <div className="space-y-2">
                            {libraryRows.map(row => {
                              const isActive = original?.ollama_model === row.name;
                              const isPulling = pulling?.name === row.name;
                              return (
                                <div
                                  key={row.name}
                                  className="flex items-center gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5"
                                  data-testid={`library-row-${row.name}`}
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-mono font-medium text-gray-900 truncate">{row.name}</div>
                                    <div className="text-[11px] text-gray-500">
                                      {row.name === recommendation?.recommendedModel
                                        ? S.model.rowRecommended
                                        : row.installed
                                          ? [row.parameter_size, row.size ? formatSize(row.size) : null].filter(Boolean).join(' · ') || S.model.rowInstalled
                                          : S.model.rowNotInstalled}
                                      {row.canThink ? S.model.rowCanThink : ''}
                                    </div>
                                    {isPulling && (
                                      <div className="mt-1.5 h-1 rounded-full bg-gray-100 overflow-hidden" data-testid="pull-progress">
                                        <div
                                          className="h-full rounded-full bg-blue-500 transition-[width]"
                                          style={{ width: `${Math.round((pulling.fraction ?? 0.02) * 100)}%` }}
                                        />
                                      </div>
                                    )}
                                  </div>
                                  {isActive && (
                                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">
                                      {S.model.activeBadge}
                                    </span>
                                  )}
                                  {!row.installed && !isPulling && (
                                    <button
                                      onClick={() => handlePull(row.name)}
                                      disabled={pulling !== null}
                                      data-testid={`download-${row.name}`}
                                      className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-40"
                                    >
                                      <Download size={12} />
                                      {S.model.download}
                                    </button>
                                  )}
                                  {row.installed && !isActive && (
                                    <button
                                      onClick={() => handleRemove(row.name)}
                                      title={S.model.removeModelTitle}
                                      aria-label={S.model.removeModelAria(row.name)}
                                      className="shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                            {libraryRows.length === 0 && (
                              <p className="text-[11px] text-amber-700 leading-relaxed">
                                {S.model.ollamaUnreachable}
                              </p>
                            )}
                          </div>

                          {libraryError && (
                            <p className="mt-2 text-[11px] text-red-600">{libraryError}</p>
                          )}
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
                <span className="text-green-700 flex items-center gap-1 font-medium">
                  <Check size={12} />
                  {S.footer.activated}
                </span>
              ) : needsKey ? (
                <span className="text-amber-700 font-medium">
                  {S.footer.needsKey}
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
                <span className="text-green-700 flex items-center gap-1 font-medium">
                  <Check size={12} />
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
          {tab === 'model' && (
            <button
              onClick={handleSave}
              disabled={saving || loading || !canActivate}
              title={
                needsKey
                  ? S.footer.activateTitleNeedsKey
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
