/**
 * components/SettingsModal/LocalLibrary.tsx
 *
 * Step 2 of the model tab for the local provider (grill 2026-10-27,
 * decisions 2–10; design/mockup-local-library.html §01 A, §02 A, §03 A,
 * §04 A, §05 A, §07 C). The settings are the library:
 *
 *   1. the hardware line: the machine's GPU (or Apple Silicon / no GPU)
 *      and the memory a model may occupy;
 *   2. the recommendation card — only while the model that fits is NOT
 *      installed: a Download door IN the app with a progress bar, then
 *      "ready · 32k window" and a one-time "Answer locally now" door
 *      (decision 8: the app never switches by itself). Without Ollama the
 *      card stays and the door becomes the platform's one-liner plus a link
 *      to ollama.com (decision 10);
 *   3. ONE list in which every model appears exactly once (user feedback
 *      2026-10-31, §07 C): the installed vision models as radio rows —
 *      selected like the cloud list in `ModelTierList`, saved by the
 *      Activate button at the bottom of the tab — the recommended one first
 *      with its badge, the one in use with the same green marker as the
 *      provider card; and the models that would also fit as download rows.
 *
 * The composer pill remains the other door to the same setting.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, Cpu, Download, ExternalLink, Loader2, RefreshCw, Trash2, Zap } from 'lucide-react';
import { api } from '../../api';
import { useStrings } from '../../strings';
import { CARD_ACTION_BTN, CARD_ACTION_BTN_DISABLEABLE, CARD_ACTION_LINK } from '../ChatArea/cardActionButton';
import type { OllamaModelInfo, PullProgress, Recommendation, RecommendedModel, Settings } from '../../types';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

// The hardware line's content chips (STYLE.md "Chips and badges": pill-shaped,
// border-less, the same recipe as the outline chip in the HtmlPane header).
const HW_CHIP = 'inline-flex items-center rounded-full bg-gray-100 px-2.5 py-[3px] text-[11px] font-medium text-gray-700';

// "NVIDIA GeForce RTX 5080 Laptop GPU" is 34 characters; the chip shows
// "RTX 5080 Laptop GPU" and keeps the full name in its tooltip (mockup §08 C).
const GPU_VENDOR_PREFIX = /^(?:(?:NVIDIA|AMD|Intel)\s+)?(?:(?:GeForce|Radeon|Arc)\s+)?/i;
export function shortGpuName(name: string): string {
  const short = name.replace(GPU_VENDOR_PREFIX, '').trim();
  return short || name;
}
const LINUX_INSTALL_COMMAND = 'curl -fsSL https://ollama.com/install.sh | sh';

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// One download in flight or finished — keyed by model name so the card and
// the download rows share the same machinery.
interface PullState {
  progress: PullProgress | null;
  ready: boolean;
  contextLength: number | null;
  error: string | null;
}

interface Props {
  // The installed vision models and their loader — owned by the modal, which
  // also refreshes them after a Remove or a finished download.
  ollamaModels: OllamaModelInfo[];
  ollamaModelsLoading: boolean;
  onRefreshModels: () => void;
  // The saved settings: which local model is in use (green marker).
  original: Settings | null;
  // The radio list's form value and setter — the modal saves it on Activate.
  value: string;
  onChange: (name: string) => void;
  // "Answer locally now" saved the switch — the modal applies the result.
  onSwitched: (settings: Settings) => void;
  // Step label of the surrounding numbered flow.
  stepLabel: React.ReactNode;
}

export function LocalLibrary({ ollamaModels, ollamaModelsLoading, onRefreshModels, original, value, onChange, onSwitched, stepLabel }: Props) {
  const S = useStrings().settings.model;
  const L = S.library;
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [copied, setCopied] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Models whose 32k window was just set from the row door (name → window).
  const [windowSet, setWindowSet] = useState<Record<string, number>>({});
  const [windowError, setWindowError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const loadRecommendation = () => {
    api.getRecommendation().then(setRec).catch(() => setRec(null));
  };
  useEffect(loadRecommendation, []);

  const installedNames = new Set(ollamaModels.map(m => m.name));
  const isInstalled = (m: RecommendedModel) => m.installed || installedNames.has(m.name);

  const pull = async (name: string) => {
    setPulls(prev => ({ ...prev, [name]: { progress: { status: 'starting' }, ready: false, contextLength: null, error: null } }));
    const result = await api.pullOllamaModel(name, progress => {
      setPulls(prev => ({ ...prev, [name]: { ...(prev[name] ?? { ready: false, contextLength: null, error: null }), progress } }));
    });
    setPulls(prev => ({
      ...prev,
      [name]: { progress: null, ready: result.ready, contextLength: result.contextLength, error: result.error ?? null },
    }));
    if (result.ready) {
      onRefreshModels();
      loadRecommendation();
    }
  };

  const remove = async (name: string) => {
    setRemoveError(null);
    try {
      await api.deleteOllamaModel(name);
      setPulls(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      onRefreshModels();
      loadRecommendation();
    } catch (err) {
      setRemoveError(L.removeFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  const setWindow = async (name: string) => {
    setWindowError(null);
    try {
      const r = await api.setOllamaContextLength(name);
      setWindowSet(prev => ({ ...prev, [name]: r.contextLength }));
      onRefreshModels();
    } catch (err) {
      setWindowError(L.setWindowFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  const switchToLocal = async (name: string) => {
    setSwitching(true);
    try {
      const result = await api.updateSettings({ llm_provider: 'ollama', ollama_model: name });
      onSwitched(result);
      // The offer is one-time: once taken, the model is a plain row.
      setPulls(prev => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    } finally {
      setSwitching(false);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(LINUX_INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* no clipboard (older webviews) — the text is selectable */ }
  };

  // The two chips of the hardware line: what the machine is, and the memory
  // a model may occupy (decision 2: one normalised number per machine).
  const hardwareChips = (r: Recommendation): { machine: string; fullName?: string; memory: string } => {
    const hw = r.hardware;
    if (hw.basis === 'vram' && hw.gpu) {
      return { machine: shortGpuName(hw.gpu.name), fullName: hw.gpu.name, memory: L.hardwareVram(Math.round(hw.usableGb)) };
    }
    if (hw.basis === 'unified') return { machine: L.hardwareUnified, memory: L.hardwareUnifiedGb(Math.round(hw.usableGb)) };
    return { machine: L.hardwareNoGpu, memory: L.hardwareRam(hw.totalMemGb) };
  };

  // The download door, the bar while it runs (the same meter the cloud list
  // draws for quotas: h-1, rounded, token colors), or the error — shared by
  // the card and the download rows.
  const downloadDoor = (m: RecommendedModel, testId: string, label: string) => {
    const st = pulls[m.name];
    if (st?.progress) {
      const { total, completed } = st.progress;
      const pct = total && completed ? Math.min(100, Math.round((completed / total) * 100)) : 0;
      return (
        <div className="w-full" data-testid={`download-progress-${m.name}`} aria-busy="true">
          <div className="h-1 rounded-full bg-gray-200 overflow-hidden">
            <div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-gray-500">
            {total && completed ? L.progress(formatSize(completed), formatSize(total)) : st.progress.status}
          </div>
        </div>
      );
    }
    return (
      <button type="button" onClick={() => pull(m.name)} className={CARD_ACTION_BTN} data-testid={testId}>
        <Download size={11} />
        {label}
      </button>
    );
  };

  const recommended = rec?.recommended ?? null;
  const recState = recommended ? pulls[recommended.name] : undefined;
  const recInstalled = recommended ? isInstalled(recommended) : false;
  // The card lives while the fitting model is missing, and once more while
  // the one-time "Answer locally now" offer is open.
  const showCard = recommended !== null && (!recInstalled || Boolean(recState?.ready));

  // The one list: installed rows, the recommended one first; then the
  // fitting models that are not installed, as download rows.
  const installedRows = [...ollamaModels].sort((a, b) =>
    Number(b.name === recommended?.name) - Number(a.name === recommended?.name),
  );
  const downloadRows = rec?.ollamaReachable ? rec.alsoFits.filter(m => !isInstalled(m) && !pulls[m.name]?.ready) : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        {stepLabel}
        <button
          type="button"
          onClick={() => { onRefreshModels(); loadRecommendation(); }}
          disabled={ollamaModelsLoading}
          data-tip={S.refreshList}
          aria-label={S.refreshList}
          className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={ollamaModelsLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {rec && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-gray-600 mb-2.5" data-testid="hardware-line">
          <Cpu size={13} className="shrink-0 text-gray-400" />
          <span className="mr-0.5">{L.hardwareLabel}</span>
          {(() => {
            const { machine, fullName, memory } = hardwareChips(rec);
            return (
              <>
                <span className={HW_CHIP} data-tip={fullName && fullName !== machine ? fullName : undefined} data-testid="hardware-machine">{machine}</span>
                <span className={HW_CHIP} data-testid="hardware-memory">{memory}</span>
              </>
            );
          })()}
        </div>
      )}

      {showCard && recommended && (
        <div
          className={`rounded-lg border px-3 py-2.5 mb-2.5 ${
            recState?.ready ? 'border-gray-200 bg-gray-50' : 'border-blue-200 bg-blue-50'
          }`}
          data-testid="recommended-card"
        >
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13px] font-mono font-semibold text-gray-900">{recommended.name}</span>
            <span className="text-[11px] text-gray-500">
              {recommended.label} · {L.downloadSize(recommended.downloadGb)} · {recommended.fits ? L.fitsWindow : L.needsGb(recommended.fitsGb)}
            </span>
          </div>

          {recState?.ready ? (
            <>
              <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-green-700" data-testid="recommended-ready">
                <Check size={11} />
                {recState.contextLength ? L.readyWindow(Math.round(recState.contextLength / 1024)) : L.readyNoWindow}
              </div>
              <p className="mt-1 mb-2 text-[12px] text-gray-700 leading-relaxed">{L.readyNote}</p>
              <button
                type="button"
                onClick={() => switchToLocal(recommended.name)}
                disabled={switching}
                aria-busy={switching}
                className={CARD_ACTION_BTN_DISABLEABLE}
                data-testid="switch-local"
              >
                {switching ? <Loader2 size={11} className="animate-spin" /> : <Zap size={11} />}
                {L.switchNow}
              </button>
            </>
          ) : !rec?.ollamaReachable ? (
            <>
              <p className="mt-1 mb-1.5 text-[12px] text-gray-700 leading-relaxed">
                {L.recommendedTitle}. {L.needsOllama}
                {rec?.hardware.platform === 'linux' ? ` ${L.linuxOneLiner}` : ''}
              </p>
              {rec?.hardware.platform === 'linux' && (
                <div className="flex items-center gap-2 rounded-md bg-gray-100 px-2 py-1.5 mb-2 text-[11.5px] font-mono text-gray-900">
                  <span className="flex-1 truncate" data-testid="install-command">{LINUX_INSTALL_COMMAND}</span>
                  <button
                    type="button"
                    onClick={copyCommand}
                    aria-label={L.copy}
                    data-tip={copied ? L.copied : L.copy}
                    className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
                  >
                    {copied ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                </div>
              )}
              <a
                href={OLLAMA_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={CARD_ACTION_LINK}
                data-testid="install-ollama"
              >
                <ExternalLink size={11} />
                {S.installOllama}
              </a>
              <p className="mt-2 text-[11px] text-gray-500 leading-relaxed">{L.afterInstall}</p>
            </>
          ) : (
            <>
              <p className="mt-1 mb-2 text-[12px] text-gray-700 leading-relaxed">
                {recommended.fits ? `${L.recommendedTitle}. ${L.fitsNote}` : L.cpuNote}
              </p>
              {downloadDoor(recommended, 'download-recommended', recommended.fits ? L.download : L.downloadAnyway)}
              {recState?.error && (
                <p className="mt-2 text-[11px] text-red-600 leading-relaxed">{L.downloadFailed(recState.error)}</p>
              )}
            </>
          )}
        </div>
      )}

      {(installedRows.length > 0 || downloadRows.length > 0) && (
        <div role="radiogroup" data-testid="local-model-list" className="rounded-lg border border-gray-200 overflow-hidden">
          {installedRows.map(row => {
            const selected = row.name === value;
            const inUse = original?.llm_provider === 'ollama' && original.ollama_model === row.name;
            const isRecommended = row.name === recommended?.name;
            const window = windowSet[row.name] ?? row.contextLength ?? null;
            // A measured window below the baked target: the paper would not
            // fit — the row says so and offers the same bake the download does.
            const windowTooSmall = window !== null && window < 32768;
            return (
              <div
                key={row.name}
                className={`flex items-center gap-2.5 px-3 py-2 border-b border-gray-50 last:border-b-0 transition-colors ${
                  selected ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange(row.name)}
                  data-testid={`library-row-${row.name}`}
                  className="flex-1 min-w-0 flex items-center gap-2.5 text-left"
                >
                  <span
                    className={`shrink-0 w-3.5 h-3.5 rounded-full border ${
                      selected ? 'border-blue-600 border-[4.5px] bg-white' : 'border-gray-300 bg-white'
                    }`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 text-[13px] font-mono font-medium text-gray-900">
                      <span className="truncate">{row.name}</span>
                      {isRecommended && (
                        <span className="shrink-0 inline-flex items-center rounded-full border border-blue-200 px-1.5 py-px text-[10px] font-semibold text-blue-700 whitespace-nowrap font-sans">
                          {L.recommendedBadge}
                        </span>
                      )}
                      {inUse && (
                        <span
                          className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase tracking-wider text-green-700 font-sans"
                          title={S.activeTitle}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                          {S.activeBadge}
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-gray-500">
                      {[row.parameter_size, row.size ? formatSize(row.size) : null].filter(Boolean).join(' · ') || S.rowInstalled}
                      {row.canThink ? S.rowCanThink : ''}
                      {' · '}
                      <span className={windowTooSmall ? 'text-amber-700 font-semibold' : ''} data-testid={`window-${row.name}`}>
                        {window !== null ? L.windowBadge(Math.round(window / 1024)) : L.windowUnknown}
                      </span>
                    </span>
                  </span>
                </button>
                {windowTooSmall && (
                  <button type="button" onClick={() => setWindow(row.name)} className={CARD_ACTION_BTN} data-tip={L.setWindowNote} data-testid={`set-window-${row.name}`}>
                    {L.setWindow}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(row.name)}
                  aria-label={L.remove(row.name)}
                  data-tip={L.remove(row.name)}
                  className="shrink-0 p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}

          {downloadRows.map(m => (
            <div
              key={m.name}
              className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-50 last:border-b-0"
              data-testid={`library-row-${m.name}`}
            >
              {/* The radio's place stays empty: nothing to choose before the download. */}
              <span className="shrink-0 w-3.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-mono font-medium text-gray-900 truncate">{m.name}</div>
                <div className="text-[11px] text-gray-500">{m.label} · {L.downloadSize(m.downloadGb)} · {L.alsoFits}</div>
                {pulls[m.name]?.error && (
                  <div className="mt-1 text-[11px] text-red-600">{L.downloadFailed(pulls[m.name].error!)}</div>
                )}
              </div>
              <div className="shrink-0 w-32 flex justify-end">
                {downloadDoor(m, `download-${m.name}`, L.download)}
              </div>
            </div>
          ))}
        </div>
      )}

      {ollamaModels.length === 0 && rec && !rec.ollamaReachable && (
        <p className="mt-2 text-[11px] text-amber-700 leading-relaxed">{S.ollamaUnreachable}</p>
      )}
      {removeError && (
        <p className="mt-2 text-[11px] text-red-600 leading-relaxed">{removeError}</p>
      )}
      {windowError && (
        <p className="mt-2 text-[11px] text-red-600 leading-relaxed">{windowError}</p>
      )}
    </div>
  );
}
