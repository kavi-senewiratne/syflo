/**
 * chat/branchSource.ts
 *
 * Where the source of a branch lives — the one passage it was opened from.
 * Two callers share this decision (2026-08-02):
 *   - the "Branched from" quote in the branch header
 *   - a click on a mind-map node (user request 2026-08-02: a node click must
 *     also jump to the spot in the PDF / in the parent chat, not just switch
 *     chats)
 *
 * Both anchor kinds point at their branch from the opposite side: a PDF
 * highlight via `chatId`, a chat-text highlight via `childChatId`. The PDF
 * wins when a branch somehow has both — with a source attached, the PDF is
 * what the user is looking at.
 */

import type { Highlight, HighlightColor, MessageHighlight } from '../types';

export type BranchSourceJump =
  | { kind: 'pdf'; highlightId: string }
  | {
      kind: 'chat';
      chatId: string;
      messageId: string;
      startOffset: number;
      endOffset: number;
      color: HighlightColor;
      highlightId: string;
    };

interface Sources {
  /** PDF highlights of the tree (as loaded for the PDF pane). */
  pdfHighlights: Highlight[];
  /** Chat-text highlights of the branch's PARENT chat. */
  parentHighlights: MessageHighlight[];
}

export function branchSourceJump(
  branchChatId: string,
  { pdfHighlights, parentHighlights }: Sources,
): BranchSourceJump | null {
  const pdf = pdfHighlights.find((h) => h.chatId === branchChatId);
  if (pdf) return { kind: 'pdf', highlightId: pdf.id };

  const chat = parentHighlights.find((h) => h.childChatId === branchChatId);
  if (chat) {
    return {
      kind: 'chat',
      chatId: chat.chatId,
      messageId: chat.messageId,
      startOffset: chat.startOffset,
      endOffset: chat.endOffset,
      color: chat.color,
      highlightId: chat.id,
    };
  }
  return null;
}
