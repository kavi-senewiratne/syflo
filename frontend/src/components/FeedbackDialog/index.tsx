/**
 * components/FeedbackDialog/index.tsx
 *
 * Opened from the sidebar Feedback button or the /feedback composer command
 * (design/mockup-feedback.html). Kind chip (Bug/Idea/Question) + text +
 * optional reply-to email — goes to a private inbox, never an automatic
 * public GitHub issue (ADR-0010). Text only: no image/video attachments,
 * hence the hint under the textarea.
 */
import { useEffect, useState } from 'react';
import { X, Send, Check } from 'lucide-react';
import { api } from '../../api';
import { useStrings } from '../../strings';
import type { FeedbackKind } from '../../types';

interface Props {
  open: boolean;
  onClose: () => void;
  // Pre-fills the text field — used by the /feedback composer command to
  // carry over whatever the user had already typed.
  initialText?: string;
}

const KINDS: { value: FeedbackKind; labelKey: 'kindBug' | 'kindIdea' | 'kindQuestion' }[] = [
  { value: 'bug', labelKey: 'kindBug' },
  { value: 'idea', labelKey: 'kindIdea' },
  { value: 'question', labelKey: 'kindQuestion' },
];

export function FeedbackDialog({ open, onClose, initialText = '' }: Props) {
  const S = useStrings().feedback;
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [text, setText] = useState(initialText);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // GitHub-issues fallback shown next to the error (hybrid feedback,
  // 2026-08-08): a failed send must never be a dead end.
  const [issuesUrl, setIssuesUrl] = useState<string | null>(null);

  // App.tsx keeps ONE dialog instance mounted and just flips `open` — so
  // useState(initialText) alone only ever seeds the very first mount.
  // Re-seed (and drop any leftover session from the previous open) every
  // time it opens again (bug found live 2026-08-02: "/feedback hello"
  // opened the dialog with an empty textarea).
  useEffect(() => {
    if (!open) return;
    setKind('bug');
    setText(initialText);
    setEmail('');
    setSending(false);
    setSent(false);
    setError(null);
    setIssuesUrl(null);
  }, [open, initialText]);

  if (!open) return null;

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      await api.sendFeedback(kind, text, email || undefined);
      setSent(true);
    } catch {
      setError(S.error);
      api.getFeedbackIssuesUrl().then(setIssuesUrl);
    } finally {
      setSending(false);
    }
  }

  return (
    <div data-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">{S.title}</h3>
          <button onClick={onClose} aria-label={S.close} className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X size={16} />
          </button>
        </div>

        {sent ? (
          <div className="flex items-center gap-2 px-5 py-8 justify-center text-sm font-medium text-gray-900">
            <Check size={16} className="text-blue-600" />
            {S.sent}
          </div>
        ) : (
          <>
            <div className="px-5 py-4 space-y-3">
              <div className="flex gap-1.5">
                {KINDS.map(k => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
                      kind === k.value ? 'bg-blue-600 text-white border-blue-600' : 'text-gray-600 border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    {S[k.labelKey]}
                  </button>
                ))}
              </div>

              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={S.placeholder}
                rows={4}
                className="w-full min-h-[84px] border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-700 bg-gray-50 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
              />
              <p className="text-xs text-gray-500 leading-relaxed">{S.attachmentHint}</p>

              <div>
                <label className="text-xs font-semibold text-gray-500">{S.emailLabel}</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder={S.emailPlaceholder}
                  className="mt-1.5 w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-700 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                />
              </div>

              {error && (
                <p className="text-xs text-red-600">
                  {error}{' '}
                  {issuesUrl && (
                    <a
                      href={issuesUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 underline underline-offset-2 hover:text-blue-700"
                    >
                      {S.errorIssueLink}
                    </a>
                  )}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 pb-5">
              <button onClick={onClose} className="text-sm font-medium px-3.5 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">
                {S.cancel}
              </button>
              <button
                onClick={handleSend}
                disabled={sending || !text.trim()}
                className="flex items-center gap-1.5 text-sm font-semibold px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Send size={13} />
                {sending ? S.sending : S.send}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
