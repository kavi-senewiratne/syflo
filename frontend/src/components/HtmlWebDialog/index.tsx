/**
 * components/HtmlWebDialog/index.tsx
 *
 * The "Web page" dialog from the Plus menu (ADR-0013 "Web pages"; hint state
 * from design/mockup-html-source.html §03, variant A).
 *
 * It wears the SAME anatomy as the other "add a source" dialogs (YouTube
 * transcript, research paper — user decision 2026-09-30: every source loads
 * the same way): icon + title, one explanatory line, an input row with the
 * filled button inline, outcomes below. No footer bar, no pill-sized primary.
 *
 * The typed address is rendered by the backend (JavaScript pages are executed
 * first) and ends as an ordinary HTML source. The one failure that is NOT a
 * fault is a page that really shows nothing — login wall, paywall, captcha.
 * That is a limit of the page, so it gets a quiet gray hint line with an Info
 * icon plus one accent-pill exit, "Upload HTML file"; the red error surface
 * stays reserved for real errors (STYLE.md).
 */

import { useEffect, useRef, useState } from 'react';
import { Code, Globe, Info, Loader2, X } from 'lucide-react';
import { HtmlNoReadableTextError } from '../../api';
import { useStrings } from '../../strings';
import { CARD_ACTION_BTN_DISABLEABLE } from '../ChatArea/cardActionButton';

interface Props {
  /** Resolves once the page is attached; the parent closes the dialog. */
  onImport: (url: string) => Promise<void>;
  onClose: () => void;
  /** The exit for a page that shows nothing: a saved HTML file instead. */
  onUploadFile: (file: File) => void;
}

type Outcome = { kind: 'no-text' } | { kind: 'error'; message: string } | null;

export function HtmlWebDialog({ onImport, onClose, onUploadFile }: Props) {
  const S = useStrings().htmlPane;
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // A second submit dispatched before React re-renders the busy button.
  const busyRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async () => {
    const value = url.trim();
    if (!value || busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setOutcome(null);
    try {
      await onImport(value);
    } catch (err) {
      setOutcome(
        err instanceof HtmlNoReadableTextError
          ? { kind: 'no-text' }
          : { kind: 'error', message: S.webError(err instanceof Error ? err.message : String(err)) },
      );
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="html-web-title"
      data-testid="html-web-dialog"
      data-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        {/* Header — icon + title, as in the YouTube dialog */}
        <div className="flex items-center justify-between px-5 pt-4">
          <h3 id="html-web-title" className="flex items-center gap-2 text-[15px] font-semibold text-gray-900">
            <Globe size={17} className="text-blue-600" aria-hidden="true" />
            {S.webTitle}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={S.close}
            className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        </div>
        <p className="px-5 pt-1 text-[12.5px] text-gray-500">{S.webSubtitle}</p>

        {/* Address row — the filled button sits inline with the input */}
        <div className="flex items-center gap-2 px-5 py-3">
          <div className="flex flex-1 items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/15">
            <Globe size={16} className="shrink-0 text-gray-400" aria-hidden="true" />
            <input
              ref={inputRef}
              type="url"
              inputMode="url"
              aria-label={S.webUrlLabel}
              placeholder={S.webUrlPlaceholder}
              value={url}
              onChange={(e) => { setUrl(e.target.value); setOutcome(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
              className="min-w-0 flex-1 text-sm text-gray-900 outline-none placeholder:text-gray-400"
              data-testid="html-web-url-input"
            />
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading || url.trim() === ''}
            aria-busy={loading}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-500"
            data-testid="html-web-submit"
          >
            {loading && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            {S.webLoad}
          </button>
        </div>

        {/* Outcomes — below the row, like the YouTube dialog's results area */}
        {outcome && (
          <div className="flex flex-col gap-2.5 px-5 pb-4">
            {outcome.kind === 'no-text' && (
              <>
                <p
                  data-testid="html-web-no-text"
                  className="flex items-start gap-1.5 text-[13px] text-gray-500"
                >
                  <Info size={13} className="mt-[3px] shrink-0" aria-hidden="true" />
                  {S.webNoText}
                </p>
                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="text/html,.html,.htm"
                    className="hidden"
                    data-testid="html-web-file-input"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) onUploadFile(file);
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className={CARD_ACTION_BTN_DISABLEABLE}
                  >
                    <Code size={11} className="shrink-0" aria-hidden="true" />
                    {S.webUploadInstead}
                  </button>
                </div>
              </>
            )}

            {outcome.kind === 'error' && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
                {outcome.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
