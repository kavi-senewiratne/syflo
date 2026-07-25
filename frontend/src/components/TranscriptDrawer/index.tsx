/**
 * components/TranscriptDrawer/index.tsx
 *
 * Roh-Transkript-Ansicht als Drawer über der Chat-Spalte (ADR-0005,
 * design/mockup-youtube-transcript.html section 05) — gleicher Slot-
 * Mechanismus wie der HighlightsDrawer. Zeigt exakt den Text, den das
 * Modell im System-Prompt sieht: Absätze mit groben Minutenmarken.
 * Esc schließt (wie beim HighlightsDrawer).
 */

import { useEffect, useMemo } from 'react';
import { FileText, X } from 'lucide-react';
import { useStrings } from '../../strings';
import type { Video } from '../../types';
import { formatDuration } from '../VideoBanner';

interface Props {
  video: Video;
  onClose: () => void;
}

// "[01:30] Text…"-Blöcke in { time, text } zerlegen; Text ohne führende
// Marke (sollte nicht vorkommen) wird ohne Zeit gerendert.
function parseBlocks(transcript: string): { time: string | null; text: string }[] {
  return transcript
    .split(/\n\n+/)
    .map((block) => {
      const m = block.match(/^\[(\d+:\d{2}(?::\d{2})?)\]\s*([\s\S]*)$/);
      return m ? { time: m[1], text: m[2] } : { time: null, text: block };
    })
    .filter((b) => b.text.trim().length > 0);
}

export function TranscriptDrawer({ video, onClose }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().transcriptDrawer;
  const blocks = useMemo(() => parseBlocks(video.transcript ?? ''), [video.transcript]);
  const duration = formatDuration(video.duration_seconds);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-testid="transcript-drawer"
      className="absolute inset-0 z-20 flex flex-col bg-white shadow-[-10px_0_28px_rgba(15,23,42,0.10)]"
    >
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 pt-4 pb-3">
        <FileText size={15} className="text-gray-400" />
        <h2 className="flex-1 text-[13px] font-semibold text-gray-900">
          {S.title}{duration ? ` · ${duration}` : ''}
        </h2>
        <button
          type="button"
          aria-label={S.close}
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          <X size={15} />
        </button>
      </div>
      <p className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-[11.5px] leading-relaxed text-gray-500">
        {S.sourceNote}
        {video.language ? S.languageNote(video.language) : ''}
      </p>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {blocks.map((b, i) => (
          <div key={i} className="mb-3.5">
            {b.time && (
              <span className="mb-1 inline-block rounded-md bg-blue-50 px-1.5 py-px font-mono text-[10.5px] font-medium text-blue-600">
                {b.time}
              </span>
            )}
            <p className="text-[13px] leading-relaxed text-gray-700">{b.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
