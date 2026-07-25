/**
 * components/ChatArea/ModelPicker.tsx
 *
 * Die Modell-Pille unten rechts im Composer + ihr Drop-up-Menü
 * (design/mockup-model-picker.html, Sektion 02). Zuständigkeit strikt
 * getrennt: der Picker WECHSELT nur zwischen installierten Vision-Modellen —
 * Downloads, Entfernen und Provider leben in den Settings ("one owner per
 * job"). Fehlt das empfohlene Modell, gibt es nur eine dezente Hinweiszeile,
 * die zu den Settings führt.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Lightbulb } from 'lucide-react';
import { useStrings } from '../../strings';
import type { OllamaModelInfo } from '../../types';

export interface ModelPickerProps {
  activeModel: string;
  models: OllamaModelInfo[];
  // Hardware-Empfehlung für diesen Rechner (null solange unbekannt).
  recommendedModel?: string | null;
  onSelectModel: (name: string) => void;
  // Thinking-Zeile: nur sichtbar, wenn das aktive Modell denken kann.
  think: boolean;
  onToggleThink: () => void;
  // "Manage models" → Settings, Model-Tab.
  onOpenSettings: () => void;
  disabled?: boolean;
  // Warnung vom Prefix-Warm-up: Modell liegt nur teilweise im GPU-Speicher
  // (CPU-Offloading = 10–20× langsamer). null, wenn alles gut ist.
  gpuWarning?: string | null;
}

export function ModelPicker({ activeModel, models, recommendedModel, onSelectModel, think, onToggleThink, onOpenSettings, disabled, gpuWarning }: ModelPickerProps) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().modelPicker;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  // Menü schließt bei Klick außerhalb.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (pillRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const active = models.find(m => m.name === activeModel);
  const canThink = Boolean(active?.canThink);
  const recommendedMissing =
    Boolean(recommendedModel) && !models.some(m => m.name === recommendedModel);

  const hintFor = (m: OllamaModelInfo): string => {
    if (m.name === recommendedModel) return S.recommended;
    return m.parameter_size ? S.installedWithSize(m.parameter_size) : S.installed;
  };

  return (
    <div className="relative shrink-0 @max-[19rem]:hidden">
      {/* Schmale Chat-Spalte (Container-Queries wie beim Mikro-Knopf): die
          Pille schrumpft erst auf 8rem, unter 19rem verschwindet sie ganz —
          eine namenlose Chevron-Pille las sich als kaputter Knopf und
          quetschte die Texteingabe auf wenige Zeichen Breite
          (Nutzer-Screenshot 2026-07-22). Modellwechsel geht dann über eine
          breitere Spalte (Resizer) oder die Settings. */}
      <button
        ref={pillRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={S.switchModel(activeModel)}
        data-testid="model-pill"
        className="h-9 max-w-[11rem] @max-[23rem]:max-w-[8rem] px-3 inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 text-[12.5px] font-medium text-gray-500 hover:text-gray-800 transition-colors disabled:opacity-50"
      >
        <span className="truncate">{activeModel}</span>
        {gpuWarning && (
          <AlertTriangle
            size={13}
            data-testid="gpu-warning-dot"
            className="shrink-0 text-amber-500"
          />
        )}
        <ChevronDown size={13} className="shrink-0" />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="model-menu"
          className="absolute bottom-full right-0 mb-2 z-30 w-72 bg-white border border-gray-200 rounded-xl shadow-lg p-1.5 text-sm"
        >
          {models.map(m => {
            const isActive = m.name === activeModel;
            return (
              <button
                key={m.name}
                role="menuitem"
                onClick={() => { onSelectModel(m.name); setOpen(false); }}
                data-testid={`model-item-${m.name}`}
                className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-colors ${
                  isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                }`}
              >
                <span className="flex-1 min-w-0">
                  <span className="block font-semibold text-gray-900 text-[13px] truncate">{m.name}</span>
                  <span className="block text-[11.5px] text-gray-500">{hintFor(m)}</span>
                </span>
                {isActive && <Check size={14} className="shrink-0 mt-0.5 text-blue-700" />}
              </button>
            );
          })}

          {/* Empfohlenes Modell fehlt → dezente Hinweiszeile, Download NUR in
              den Settings (Download-Gate; der Picker lädt nie selbst). */}
          {recommendedMissing && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onOpenSettings(); }}
              data-testid="model-recommend-hint"
              className="w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left bg-gray-50 hover:bg-gray-100 transition-colors"
            >
              <span className="flex-1 min-w-0">
                <span className="block font-medium text-gray-800 text-[13px]">
                  {S.recommendHint(recommendedModel!)}
                </span>
                <span className="block text-[11.5px] text-gray-500">{S.downloadInSettings}</span>
              </span>
              <ChevronRight size={14} className="shrink-0 mt-0.5 text-gray-400" />
            </button>
          )}

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

          {/* GPU-Warnung vom Warm-up: teilweises CPU-Offloading erklärt fast
              immer "unerklärlich" langsame Antworten — hier sichtbar machen. */}
          {gpuWarning && (
            <div
              data-testid="gpu-warning-row"
              className="flex items-start gap-2 px-2.5 py-2 mx-0 rounded-lg bg-amber-50 text-[11.5px] leading-snug text-amber-800"
            >
              <AlertTriangle size={13} className="shrink-0 mt-0.5 text-amber-500" />
              {gpuWarning}
            </div>
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

          {/* Provider-Status — zog aus der Sidebar-Fußzeile hierher um. */}
          <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[11px] text-gray-500">
            <span className={`w-1.5 h-1.5 rounded-full ${models.length > 0 ? 'bg-green-500' : 'bg-gray-300'}`} />
            {models.length > 0 ? S.ollamaRunning : S.ollamaNotReachable}
          </div>
        </div>
      )}
    </div>
  );
}
