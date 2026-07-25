/**
 * ThinkingIndicator — the chat's loading state while the assistant has not
 * yet produced its first token.
 *
 * Design source of truth: design/mockup-fun-themes-v4.html (.typing / .tdot /
 * @keyframes bounce). An AI-side bubble containing three bouncing dots; dot
 * colors and easing follow the active theme via --syflo-think-a/-b and
 * --syflo-ease-fun. All styling lives in index.css (.syflo-typing) so themes
 * can override it (e.g. Hyrule's phosphor glow).
 *
 * `withTips`: während einer echten Denk-Phase (Reasoning-Modell, think=on)
 * rotiert unter denselben Punkten eine Tipp-/Zitat-Zeile
 * (design/mockup-model-picker.html, Sektion 04). Die Gedankenkette selbst
 * wird nie gezeigt.
 */

import { useEffect, useMemo, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useStrings } from '../../strings';
import { THINKING_LINE_INTERVAL_MS } from './thinkingTips';
import { getThinkingFeed } from './thinkingFeed';

export function ThinkingIndicator({
  withTips = false,
  prefillEta,
}: {
  withTips?: boolean;
  // Prefill-ETA in Sekunden (SSE-Event `prefill`) — zeigt die Countdown-
  // Zeile aus design/mockup-prefill-progress.html §01.
  prefillEta?: number;
}) {
  const S = useStrings().messageBubble;
  return (
    <div role="status" aria-label={S.assistantThinking}>
      <div className="syflo-typing">
        <span className="syflo-typing-dot" />
        <span className="syflo-typing-dot" />
        <span className="syflo-typing-dot" />
      </div>
      {typeof prefillEta === 'number' && <PrefillEtaLine seconds={prefillEta} />}
      {withTips && <ThinkingTipLine />}
    </div>
  );
}

/**
 * PrefillEtaLine — ehrlicher Warte-Countdown, während das Modell die Quelle
 * einliest. Design source of truth: design/mockup-prefill-progress.html §01.
 * Die Sekunden sind eine SCHÄTZUNG des Backends (gemessene Prefill-Rate ×
 * ungecachte Tokens; Ollama exponiert keinen echten Fortschritt, #6029) —
 * deshalb "~" im Text, und bei Überziehung wechselt die Zeile auf
 * "dauert etwas länger" statt bei 99 % zu hängen. Balkenfarbe über den
 * Theme-Token --syflo-think-a, damit alle Themes sie umfärben.
 */
function PrefillEtaLine({ seconds }: { seconds: number }) {
  const S = useStrings().messageBubble;
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    setLeft(seconds);
    const t = window.setInterval(() => setLeft(v => v - 1), 1000);
    return () => window.clearInterval(t);
  }, [seconds]);

  const overrun = left <= 0;
  const pct = overrun ? 100 : Math.min(100, ((seconds - left) / seconds) * 100);

  return (
    <div data-testid="prefill-eta" className="mt-2 max-w-prose">
      <div className="flex items-center gap-1.5 text-[12.5px] leading-relaxed text-gray-500">
        <BookOpen size={14} className="shrink-0 opacity-70" />
        {overrun ? S.prefillLonger : S.prefillReading(left)}
      </div>
      <div className="mt-1.5 h-[3px] w-48 overflow-hidden rounded-full bg-black/[0.07]">
        <div
          className="h-full rounded-full bg-[var(--syflo-think-a,#3B82F6)] transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%`, opacity: overrun ? 0.55 : 1 }}
        />
      </div>
    </div>
  );
}

function ThinkingTipLine() {
  const S = useStrings().messageBubble;
  // App-weiter Feed (thinkingFeed.ts): 50/50 Tipp/Zitat pro Zeile, aktiver
  // Zitat-Pool mit Ausmusterung nach 3 Anzeigen, Fortschritt in localStorage.
  const feed = useMemo(() => getThinkingFeed(), []);
  const [line, setLine] = useState(() => feed.next());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => {
      setLine(feed.next());
      setTick(i => i + 1);
    }, THINKING_LINE_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, [feed]);

  return (
    <div
      key={tick}
      data-testid="thinking-tip-line"
      className="mt-2 max-w-prose text-[12.5px] leading-relaxed text-gray-500 animate-[syflo-fade-in_400ms_ease]"
    >
      {line.kind === 'tip' ? (
        <>
          <span className="font-semibold text-gray-700">{S.tipLabel}</span>
          {line.text}
        </>
      ) : (
        <>
          "{line.text}"
          <span className="block mt-0.5 text-[11.5px] opacity-85">— {line.cite}</span>
        </>
      )}
    </div>
  );
}
