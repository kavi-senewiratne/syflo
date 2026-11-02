/**
 * components/ChatArea/HtmlFreezeCard.tsx
 *
 * The warning card under the FIRST answer of an HTML tree
 * (design/mockup-html-app.html, variant B; ADR-0013 decision 7). Some network
 * resources of the page (script, stylesheet, font) could not be frozen into
 * the stored copy; the card names each with its exact reason and offers the
 * one exit that leads out: try again.
 *
 * Card rules from docs/STYLE.md: shares the base of the other cards under an
 * answer, one message line with a 13px icon, the exit is the accent pill
 * (CARD_ACTION_BTN, no gray twin), and the footer marks itself with the
 * `blue-100/40` wash — no second frame inside the bubble.
 */

import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useStrings } from '../../strings';
import { resourceLabel } from '../../html/resourceLabel';
import type { HtmlUnfrozenResource } from '../../types';
import { CARD_ACTION_BTN_DISABLEABLE } from './cardActionButton';

export interface HtmlFreezeInfo {
  unfrozen: HtmlUnfrozenResource[];
  retrying: boolean;
  onRetry: () => void;
}

export function HtmlFreezeCard({ unfrozen, retrying, onRetry }: HtmlFreezeInfo) {
  const S = useStrings().htmlPane;
  if (unfrozen.length === 0) return null;
  return (
    <div
      data-testid="html-freeze-card"
      className="mt-2 flex flex-col items-start gap-2 text-[12.5px] text-gray-400"
    >
      <div className="flex items-center gap-2">
        <TriangleAlert size={13} className="shrink-0" aria-hidden="true" />
        <span className="italic">{S.cardTitle(unfrozen.length)}</span>
      </div>
      <ul className="list-disc space-y-0.5 pl-[18px]">
        {unfrozen.map((r) => (
          <li key={`${r.url}-${r.reason}`} className="[overflow-wrap:anywhere]">
            {S.resourceLine(resourceLabel(r.url), S.reason(r.reason))}
          </li>
        ))}
      </ul>
      <div className="w-full rounded-lg bg-blue-100/40 px-3 py-2.5">
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying}
          className={CARD_ACTION_BTN_DISABLEABLE}
        >
          {retrying
            ? <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />
            : <RefreshCw size={11} className="shrink-0" aria-hidden="true" />}
          {S.retry}
        </button>
      </div>
    </div>
  );
}
