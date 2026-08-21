/**
 * BtwPanel — the answer to a `/btw` side question
 * (design/mockup-btw-composer-fold.html).
 *
 * Folds out of the composer, above the input field: it is part of the input
 * area, not a message. Nothing here is ever written to the transcript.
 *
 * The header names itself after the command that made it — "/btw", not a
 * translated noun (user decision 2026-08-08) — so the label needs no DE/EN
 * pair and teaches the trigger every time the panel opens. To its left sits
 * the same MessageCircleQuestionMark the slash-command menu gives /btw (user
 * decision 2026-08-11, revising the mockup's "no icon"): the panel and the
 * command that opened it now carry one mark, so the fold-out is recognisable
 * before the word is read.
 *
 * Closing is never explained here. Escape and the first keystroke both remove
 * the panel silently (handled in the composer); the × is the same action made
 * visible for a mouse, and therefore carries no label and no tooltip.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeftRight, GitBranch, MessageCircleQuestionMark, Pin, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ThinkingIndicator } from './ThinkingIndicator';
import { useStrings } from '../../strings';
import type { Aside } from '../../types';

interface Props {
  aside: Aside;
  // Anzeigenamen aus der Registry, damit die Wechsel-Notiz dieselben Labels
  // trägt wie die über einer Chat-Antwort. Fehlt ein Name, steht der rohe.
  modelLabels?: Record<string, string>;
  providerLabels?: Record<string, string>;
  onDismiss?: () => void;
  onKeep?: () => void;
  onBranch?: () => void;
}

export function BtwPanel({ aside, onDismiss, onKeep, onBranch, modelLabels, providerLabels }: Props) {
  const S = useStrings().chatArea;
  const answerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Der Anteil der Spaltenhöhe, den die Antwort einnehmen darf. 0.4 im
  // Normalfall, per Griff bis 0.75 — und nur für DIESE Nebenfrage: die
  // nächste öffnet wieder bei 40 % (Mockup §04, Stufe 2).
  const [heightFraction, setHeightFraction] = useState(0.4);
  const [maxHeightPx, setMaxHeightPx] = useState(Math.round(420 * 0.4));
  const [overflows, setOverflows] = useState(false);
  const dragRef = useRef<{ startY: number; startFraction: number; paneHeight: number } | null>(null);

  // Jede neue Nebenfrage beginnt wieder klein.
  useEffect(() => { setHeightFraction(0.4); }, [aside.question]);

  // Die Spaltenhöhe kennt nur das DOM — sie ändert sich mit dem Fenster und
  // mit dem PDF daneben, deshalb wird sie gemessen statt geraten.
  useEffect(() => {
    const pane = panelRef.current?.closest('.syflo-chat-pane') ?? panelRef.current?.parentElement;
    const measure = () => {
      const paneHeight = (pane as HTMLElement | null)?.clientHeight ?? 420;
      setMaxHeightPx(Math.round(paneHeight * heightFraction));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (pane) ro.observe(pane as Element);
    return () => ro.disconnect();
  }, [heightFraction]);

  // Der Griff erscheint nur, wenn die Antwort den Deckel überhaupt erreicht —
  // sonst gäbe es nichts hochzuziehen und nichts zu verbergen.
  useEffect(() => {
    const el = answerRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [aside.answer, maxHeightPx]);

  const startDrag = (e: React.PointerEvent) => {
    const pane = panelRef.current?.closest('.syflo-chat-pane') ?? panelRef.current?.parentElement;
    dragRef.current = {
      startY: e.clientY,
      startFraction: heightFraction,
      paneHeight: (pane as HTMLElement | null)?.clientHeight ?? 420,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Nach OBEN ziehen vergrößert — deshalb das umgekehrte Vorzeichen.
    const delta = (drag.startY - e.clientY) / drag.paneHeight;
    setHeightFraction(Math.min(0.75, Math.max(0.4, drag.startFraction + delta)));
  };
  const endDrag = () => { dragRef.current = null; };
  // Beide Aktionen erst, wenn die Antwort steht — aus einer halben Antwort
  // gibt es nichts zu behalten und nichts zu verzweigen.
  const done = !aside.streaming && !aside.error;

  // Ab dieser Länge ist die Antwort keine Nebenfrage mehr, sondern ein
  // Gespräch, das einen eigenen Chat verdient (Mockup §04, Stufe 3): die
  // beiden Knöpfe tauschen die Plätze und "Verzweigen" bekommt das Blau.
  // Gesagt wird dazu nichts — das Panel macht nur den richtigen Ausgang zum
  // naheliegenden. Ein Codeblock oder eine Tabelle zählt unabhängig von der
  // Länge, weil beides ohnehin nach Platz verlangt.
  const branchFirst =
    aside.answer.length > 900 || /```|^\s*\|.*\|/m.test(aside.answer);

  // Erst unter 20rem schrumpfen die beiden Knöpfe auf ihr Symbol zusammen
  // (Nutzerwunsch 2026-08-11). Zuerst stand hier 30rem wie beim
  // Markierungs-Knopf — aber der misst einen ANDEREN Container: der
  // Composer-Schacht trägt px-6/sm:px-8, und `container-type: inline-size`
  // misst die Content-Box. Dieselbe Zahl bedeutet hier also rund 64 px mehr
  // Spaltenbreite, und die Beschriftungen verschwanden sichtbar früher als
  // die des Knopfs darüber. 20rem ist die Breite, ab der die beiden
  // wirklich nicht mehr nebeneinander passen.
  //
  // Die Bedeutung trägt in der Symbol-Stufe eine eigene Kurzinfo, KEIN
  // `title`: das native Sprechblasen-Fenster kommt erst nach etwa einer
  // Sekunde und blieb im laufenden Fenster ganz aus (Nutzerbericht
  // 2026-08-11). Diese hier hängt am Knopf selbst und erscheint sofort.
  // Über 30rem ist sie ausgeblendet, sonst stünde derselbe Text zweimal da.
  // Beide Knöpfe tragen dasselbe neutrale Kleid (Nutzerentscheid
  // 2026-08-11). Vorher bekam der empfohlene Ausgang die Akzentfarbe — die
  // ist in Mushroom Kingdom Rot, und Rot liest sich als Warnung, nicht als
  // Empfehlung. Der Hinweis, welcher Ausgang bei einer langen Antwort der
  // naheliegende ist, steckt weiterhin in der REIHENFOLGE (branchFirst):
  // eine Stelle, die in keinem Theme die Farbbedeutung verdrehen kann.
  const action = (key: string, onClick: () => void, icon: React.ReactNode, text: string) => (
    <button
      key={key}
      onClick={onClick}
      aria-label={text}
      data-tip={text}
      data-tip-narrow-only="20"
      data-testid={`btw-${key}`}
      className="inline-flex h-[26px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 text-[11px] font-medium text-gray-700 hover:bg-gray-100 @max-[20rem]:px-2"
    >
      {icon}
      <span className="whitespace-nowrap @max-[20rem]:hidden">{text}</span>
    </button>
  );

  const keepButton = onKeep
    ? action('keep', onKeep, <Pin size={12} className="shrink-0 text-gray-500" />, S.btwKeep)
    : null;

  const branchButton = onBranch
    ? action('branch', onBranch, <GitBranch size={12} className="shrink-0 text-gray-500" />, S.btwBranch)
    : null;
  return (
    /* Die Hülle klappt das Panel aus dem Composer heraus (syflo-btw-in in
       index.css). Sie trägt KEINE eigene Optik — nur die Bewegung: das Panel
       stand vorher in voller Höhe da, und alles darüber sprang mit
       (Nutzerbericht 2026-08-19, "taucht zu plötzlich auf"). */
    <div className="syflo-btw-in" data-testid="btw-fold">
    <div
      ref={panelRef}
      className="relative mb-2 mx-2 rounded-xl border border-gray-200 bg-gray-50 px-3 pt-2.5 pb-3"
      data-testid="btw-panel"
    >
      {/* Ziehgriff — nur wenn die Antwort den Deckel erreicht. Kein Knopf,
          keine Beschriftung, kein Zustand zum Merken: an einer Panel-Kante
          zieht man ohnehin. */}
      {overflows && (
        <div
          onPointerDown={startDrag}
          onPointerMove={onDrag}
          onPointerUp={endDrag}
          className="absolute inset-x-0 top-0 flex h-3 cursor-ns-resize items-center justify-center"
          data-testid="btw-grip"
        >
          <span className="block h-[3px] w-6 rounded-full bg-gray-300" />
        </div>
      )}
      <div className={`mb-1.5 flex items-center gap-1.5 ${overflows ? 'mt-1' : ''}`}>
        <MessageCircleQuestionMark size={13} className="shrink-0 text-gray-500" aria-hidden="true" />
        {/* Derselbe gestrichelte Chip, den der Befehl im Chat trägt — im
            Composer neben dem Eingabefeld (/branch-Chip) und in der
            Abzweig-Zeile (BranchTrace): gestricheltes graues Kästchen,
            Monospace (Nutzerentscheid 2026-08-12). Vorher stand hier nur
            grauer Monospace-Text, also sah derselbe Befehl an drei Orten
            unterschiedlich aus. Das Icon bleibt LINKS vom Kästchen, genau
            wie in der Abzweig-Zeile. */}
        <span className="rounded border border-dashed border-gray-300 bg-gray-100 px-1.5 py-px font-mono text-[11px] font-semibold text-gray-600">
          /btw
        </span>
        <span className="flex-1" />
        {/* Während des Streams bleibt die Kopfzeile rechts LEER. Das × wäre
            falsch — ein halb gefülltes Panel klickt man nicht weg, der Ausweg
            ist Escape (bricht ab UND schließt). Punkte standen hier früher als
            Ersatz für das ×, sind aber weg (Nutzerentscheid 2026-08-11):
            seit das Antwortfeld selbst hüpfende Punkte zeigt, liefen zwei
            Ladeanzeigen für denselben Zustand. */}
        {aside.streaming ? null : (
          <button
            onClick={onDismiss}
            className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600"
            data-testid="btw-dismiss"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        )}
      </div>
      {/* Die Frage bleibt eine schlichte fette Zeile, KEINE User-Blase
          (Nutzerentscheid 2026-08-08, zweiter Anlauf): eine Blase im Panel
          las sich, als liefe der Chat plötzlich von unten nach oben. Nur die
          Schriftgrößen folgen dem Chat — Frage und Antwort in normaler
          Lesegröße statt gestaucht. */}
      {/* Akzentfarbe statt Grau-900: die Frage bleibt stehen, während die
          Antwort unter ihr wegscrollt — in reinem Fett war sie beim Scrollen
          nicht mehr von einer fetten Zeile IN der Antwort zu unterscheiden
          (Nutzerbericht 2026-08-11). Über `blue-*` folgt sie dem Theme:
          Rot in Mushroom, Blau in Ink, Grün in Matrix. */}
      <p className="text-sm font-semibold leading-snug text-blue-700">{aside.question}</p>
      {/* Der Deckel: die Antwort scrollt INNEN, Kopf, Frage und Knöpfe bleiben
          stehen (Mockup §04, Stufe 1). Der weiche Verlauf an der Unterkante
          ist das ganze "da kommt noch was"-Signal — eine Scrollleiste in
          einem 90-px-Kasten übersieht man. maxHeight kommt aus dem Ziehgriff:
          40 % der Spalte im Normalfall, bis 75 %, wenn hochgezogen. */}
      <div className="relative">
        <div
          ref={answerRef}
          className="mt-1 overflow-y-auto py-1 text-sm leading-relaxed text-gray-900"
          style={{ maxHeight: `${maxHeightPx}px` }}
          data-testid="btw-answer"
        >
          {aside.error ? (
          // Kennt das Backend die Lage beim Namen, spricht das Panel seine
          // eigene Sprache; alles Unbenannte kommt weiter im Wortlaut durch,
          // damit nichts verschluckt wird (Nutzer-Report 2026-08-20).
          aside.errorReason === 'timeout' ? S.btwTimeout : aside.error
        ) : aside.streaming && !aside.answer ? (
          // Solange kein einziges Token da ist, steht im Antwortfeld dasselbe
          // Hüpf-Punkte-Signal wie in einer Chat-Antwort (Nutzerwunsch
          // 2026-08-11) — ein leeres Feld sagt nicht, ob überhaupt etwas
          // passiert.
          <ThinkingIndicator />
        ) : (
          // Volles Markdown wie in einer echten Antwort (Nutzerwunsch
          // 2026-08-08): Listen, Überschriften, Tabellen, Code und Formeln.
          // `prose prose-sm` ist dieselbe Typografie-Klasse, die MessageBubble
          // benutzt, damit eine Nebenfrage sich nicht anders liest als der
          // Chat — nur kleiner.
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[[rehypeKatex, { errorColor: 'var(--color-gray-500, #6b7280)', strict: 'ignore' }]]}
              components={{
                // Dieselben Element-Klassen wie MessageBubble — Tailwind
                // Preflight nimmt Listen ihre Marker, die kommen nur über
                // explizite list-disc/list-decimal zurück. Nur die Abstände
                // sind enger: das Panel ist kein voller Chat.
                p({ children }) { return <p className="mb-3 last:mb-0">{children}</p>; },
                ul({ children }) {
                  return (
                    <ul className="list-disc list-outside pl-6 mb-3 space-y-1 marker:text-gray-400 [&_ul]:list-[circle] [&_ul_ul]:list-[square]">
                      {children}
                    </ul>
                  );
                },
                ol({ children }) {
                  return (
                    <ol className="list-decimal list-outside pl-6 mb-3 space-y-1 marker:text-gray-400 [&_ol]:list-[lower-alpha]">
                      {children}
                    </ol>
                  );
                },
                li({ children }) {
                  return <li className="pl-1 leading-relaxed [&>ul]:mt-1 [&>ul]:mb-0 [&>ol]:mt-1 [&>ol]:mb-0">{children}</li>;
                },
                h1({ children }) { return <h1 className="text-lg font-bold mb-2 mt-4 first:mt-0">{children}</h1>; },
                h2({ children }) { return <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>; },
                h3({ children }) { return <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{children}</h3>; },
                blockquote({ children }) {
                  return <blockquote className="border-l-4 border-gray-200 pl-4 text-gray-500 my-2">{children}</blockquote>;
                },
                code({ className, children }) {
                  const block = /language-/.test(className || '');
                  return block ? (
                    <code className="block overflow-x-auto rounded-md bg-gray-100 p-3 text-xs font-mono">{children}</code>
                  ) : (
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-mono text-gray-800">{children}</code>
                  );
                },
              }}
            >
              {aside.answer}
            </ReactMarkdown>
          </div>
        )}
        </div>
        {overflows && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-b from-transparent to-gray-50"
          />
        )}
      </div>

      {/* Die Antwort blieb unfertig (Nutzer-Report mit Bild 2026-08-20): das
          Modell brach ab, und niemand auf der Leiter konnte weiterschreiben.
          Wortlaut, Symbol und Ton sind dieselben wie unter einer gekappten
          Chat-Antwort (MessageBubble, truncated-note) — ein Abbruch liest sich
          überall gleich. Ohne Knopf: eine Nebenfrage stellt man neu, statt sie
          zu reparieren. Der Text bleibt stehen, es gibt ja echten Inhalt. */}
      {aside.truncated && !aside.streaming && !aside.error && (
        <div
          data-testid="btw-truncated-note"
          className="mt-2 flex items-center gap-2 text-[12px] text-gray-400"
        >
          <AlertCircle size={12} className="shrink-0" />
          <span className="italic">{S.truncated}</span>
        </div>
      )}

      {/* Wechsel-Notiz — NUR wenn nicht das Modell des Chats geantwortet hat;
          im Normalfall steht hier gar nichts. Wortlaut, Icon und Ton sind
          dieselben wie über einer Chat-Antwort (MessageBubble, failover-note):
          ein Modellwechsel liest sich überall gleich, egal wo er passiert
          (Nutzerwunsch 2026-08-08). */}
      {done && aside.model && (
        <div
          className="mt-2 flex items-center gap-1.5 text-[12px] italic text-gray-400"
          data-testid="btw-failover-note"
        >
          <ArrowLeftRight size={12} className="shrink-0" />
          <span>
            {aside.model.fromProvider && aside.model.fromProvider !== aside.model.toProvider
              ? S.failover(
                  providerLabels?.[aside.model.fromProvider] ?? aside.model.fromProvider,
                  providerLabels?.[aside.model.toProvider ?? ''] ?? aside.model.toProvider ?? '',
                  modelLabels?.[aside.model.answered] ?? aside.model.answered,
                )
              : S.failoverSameProvider(
                  modelLabels?.[aside.model.was] ?? aside.model.was,
                  modelLabels?.[aside.model.answered] ?? aside.model.answered,
                )}
          </span>
        </div>
      )}

      {/* flex-wrap bleibt als Netz für die Zwischenbreiten, in denen die
          Beschriftungen noch stehen, aber knapp werden — der eigentliche
          Schutz ist die Symbol-Stufe an den Knöpfen selbst. */}
      {done && (onKeep || onBranch) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {(branchFirst ? [branchButton, keepButton] : [keepButton, branchButton]).map((b) => b)}
        </div>
      )}
    </div>
    </div>
  );
}
