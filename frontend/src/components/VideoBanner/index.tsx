/**
 * components/VideoBanner/index.tsx
 *
 * Quellen-Banner für Bäume mit YouTube transcript (ADR-0005,
 * design/mockup-youtube-transcript.html section 04): eine schlanke Leiste
 * über dem Nachrichtenverlauf — auf JEDEM Chat des Baums — mit Titel, Kanal,
 * Dauer, "View transcript" (öffnet den Transkript-Drawer) und Link zum
 * Video. Das Banner ist das Video-Gegenstück zum PDF in der Mittelspalte:
 * der Nutzer sieht jederzeit, welche Quelle das Modell kennt.
 */

import { TvMinimalPlay, ExternalLink, FileText } from 'lucide-react';
import { useStrings } from '../../strings';
import type { Video } from '../../types';

// 3587 s → "59:47"; ab einer Stunde "1:05:47".
export function formatDuration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface Props {
  video: Video;
  onOpenTranscript: () => void;
}

export function VideoBanner({ video, onOpenTranscript }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().videoBanner;
  const duration = formatDuration(video.duration_seconds);
  return (
    <div
      data-testid="video-banner"
      className="flex items-center gap-3 border-b border-gray-200 bg-white px-5 py-2.5"
    >
      {/* Accent tokens, not YouTube red: blue-* is remapped per theme
          (index.css data-theme blocks); red stays reserved for errors. */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
        <TvMinimalPlay size={16} />
      </div>
      <div className="min-w-0 flex-1">
        {/* 14px statt 13: im Wurzel-Chat ist das seit dem 2026-08-15 der
            EINZIGE Ort, an dem der Video-Titel steht — die Kopfzeile darüber
            hat ihn abgegeben (Variante C, design/mockup-video-header-merge.html).
            In Zweig-Chats trägt der Kopf weiter das Zitat, das Banner den
            Titel; auch dort ist die etwas kräftigere Zeile richtig, weil sie
            die Quelle des ganzen Baums benennt. `title` bleibt: die Zeile
            schneidet ab, der volle Titel muss erreichbar sein. */}
        <p className="truncate text-sm font-semibold text-gray-900" title={video.title}>{video.title}</p>
        <p className="truncate text-[11.5px] text-gray-500">
          {video.channel}
          {duration ? ` · ${duration}` : ''}
          {S.transcriptAttached}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenTranscript}
          data-testid="video-banner-view-transcript"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
        >
          <FileText size={12} />
          {S.viewTranscript}
        </button>
        <a
          href={video.url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="video-banner-open-youtube"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
        >
          <ExternalLink size={12} />
          {S.openOnYouTube}
        </a>
      </div>
    </div>
  );
}
