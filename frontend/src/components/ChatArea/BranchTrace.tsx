/**
 * BranchTrace.tsx
 *
 * The branch line in the transcript (design/mockup-branch-trace.html,
 * variant A, decided 2026-08-09): a hairline divider carrying a pill that
 * names the command and the branch it opened, drawn at the point in time the
 * command was sent.
 *
 * Weight is deliberate: at rest it is lighter than any bubble — a date
 * separator, not a message. Hover lifts it into the blue link colours, so the
 * fork is visible while scrolling but never competes with what was said.
 */

import { useEffect, useState } from 'react';
import { ArrowRight, GitBranch, Loader2, MessageCircleQuestionMark } from 'lucide-react';
import { MathText, plainMathText } from '../MathText';
import { useStrings } from '../../strings';
import { TRACE_VISIBLE, type BranchTraceEntry } from '../../chat/branchTrace';

interface Props {
  entries: BranchTraceEntry[];
  onOpen: (chatId: string) => void;
  /** Branch whose line was jumped to from its own header — glows briefly. */
  flashChatId?: string | null;
}

// The pill says "/btw" or "/branch" — the command as typed. Not translated,
// same rule as the panel's name and the slash menu (2026-08-08).
const COMMAND: Record<BranchTraceEntry['origin'], string> = {
  btw: '/btw',
  topic: '/branch',
};

// Jeder Befehl behält sein Zeichen aus dem Slash-Menü (Nutzerhinweis
// 2026-08-09): das Fragezeichen gehört zu `/btw`, die Verzweigung zu
// `/branch`. Ein gemeinsames Icon für beide hätte die Zeile stumm gemacht.
const ICON: Record<BranchTraceEntry['origin'], typeof GitBranch> = {
  btw: MessageCircleQuestionMark,
  topic: GitBranch,
};

export function BranchTrace({ entries, onOpen, flashChatId }: Props) {
  const S = useStrings().chatArea;
  const [expanded, setExpanded] = useState(false);

  const hidden = entries.slice(TRACE_VISIBLE);
  // A jump must never land on a line that is folded away — the header link of
  // a hidden branch unfolds the stack before the glow starts.
  const flashHidden = !!flashChatId && hidden.some((e) => e.chatId === flashChatId);
  useEffect(() => {
    if (flashHidden) setExpanded(true);
  }, [flashHidden]);

  // Der Zweig braucht rund eine Sekunde, bis er geladen und gerendert ist
  // (Nutzer-Report 2026-08-09). Ohne Rückmeldung wirkt der Klick verschluckt,
  // also übernimmt die Pille selbst die Wartezeit: Icon wird zum Spinner,
  // weitere Klicks prallen ab. Zurückgesetzt wird nichts — mit dem Chatwechsel
  // verschwindet diese Zeile ohnehin; nur wenn der Wechsel scheitert, gibt der
  // Handler unten die Pille wieder frei.
  const [openingId, setOpeningId] = useState<string | null>(null);
  const open = (chatId: string) => {
    if (openingId) return;
    setOpeningId(chatId);
    const result = onOpen(chatId) as unknown;
    if (result instanceof Promise) result.catch(() => setOpeningId(null));
  };

  if (entries.length === 0) return null;
  const shown = expanded ? entries : entries.slice(0, TRACE_VISIBLE);
  const rest = entries.length - shown.length;

  return (
    <div className="flex flex-col gap-1" data-testid="branch-trace-group">
      {/* h-6 / leading-none statt einer aus der Schriftgröße abgeleiteten
          Höhe: 11,5 px Text mit leading-snug ergab 25,8 px pro Zeile, also
          landete jede zweite Pille auf einer halben Pixelposition — deren
          1-px-Rand verteilt der Browser dann auf zwei Reihen und die Zeilen
          sahen unterschiedlich dick aus (Nutzer-Screenshot 2026-08-09).
          24 px Höhe + 4 px gap halten jede Kante auf ganzen Pixeln. */}
      {shown.map((entry) => {
        const Icon = ICON[entry.origin];
        return (
        <div key={entry.chatId} className="group flex h-6 items-center gap-2">
          <span className="h-px flex-1 bg-gray-200" />
          <button
            type="button"
            data-testid={`branch-trace-${entry.chatId}`}
            data-flash={flashChatId === entry.chatId ? 'true' : undefined}
            data-opening={openingId === entry.chatId ? 'true' : undefined}
            disabled={openingId !== null}
            onClick={() => open(entry.chatId)}
            title={`${COMMAND[entry.origin]} · ${plainMathText(entry.title)} — ${S.traceOpenBranch}`}
            style={
              flashChatId === entry.chatId
                // Der Glow folgt dem Theme (Nutzerkorrektur 2026-08-09): das
                // blaue-600-Token wird in jedem Theme neu belegt — Mushroom
                // rot, Hyrule türkis, Matrix grün. Ein fester Hex-Wert blieb
                // überall blau und stach heraus.
                ? ({ '--flash-color': 'var(--color-blue-600, #2563EB)' } as React.CSSProperties)
                : undefined
            }
            // Gefüllt statt umrandet (Nutzerkorrektur 2026-08-09, Mushroom
            // Kingdom): die Pillenbreite ergibt sich aus dem Titel und landet
            // fast immer auf Bruchteilen von Pixeln (168,69 px, 184,67 px …).
            // Eine 1-px-Kontur fällt dann je nach Pille anders aufs
            // Pixelraster — die Zeilen sahen unterschiedlich dick aus, in
            // JEDEM Theme. Eine Füllung hat keine Kante, die verwaschen kann.
            className={`flex h-6 min-w-0 max-w-[78%] items-center gap-1.5 rounded-full px-2.5 text-[11.5px] leading-none transition-colors ${
              openingId === entry.chatId
                // Die geklickte Pille hält den Hover-Look fest, damit sichtbar
                // bleibt, welcher Zweig gerade lädt.
                ? 'bg-blue-50 text-blue-700'
                : 'bg-gray-100 text-gray-500 hover:bg-blue-50 hover:text-blue-700'
            } ${openingId && openingId !== entry.chatId ? 'opacity-50' : ''} ${
              flashChatId === entry.chatId ? 'syflo-hl-flash' : ''
            }`}
          >
            {openingId === entry.chatId ? (
              <Loader2 size={13} className="shrink-0 animate-spin text-blue-600" />
            ) : (
              <Icon size={13} className="shrink-0 text-gray-400 group-hover:text-blue-600" />
            )}
            {/* Derselbe Chip wie im Eingabefeld (Nutzerhinweis 2026-08-09):
                gestricheltes graues Kästchen, Monospace — der Befehl sieht in
                der Zeile aus wie beim Tippen, nur kleiner. */}
            <span className="shrink-0 rounded border border-dashed border-gray-300 px-1 py-px font-mono text-[10px] font-semibold text-gray-600">
              {COMMAND[entry.origin]}
            </span>
            <span className="truncate">
              <MathText text={entry.title} />
            </span>
            <ArrowRight
              size={12}
              className="shrink-0 text-blue-600 opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
          <span className="h-px flex-1 bg-gray-200" />
        </div>
        );
      })}
      {(rest > 0 || expanded) && entries.length > TRACE_VISIBLE && (
        <button
          type="button"
          data-testid="branch-trace-more"
          onClick={() => setExpanded((v) => !v)}
          className="self-center rounded-full px-2 py-0.5 text-[10.5px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
        >
          {expanded ? S.traceLess : S.traceMore(rest)}
        </button>
      )}
    </div>
  );
}
