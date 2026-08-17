/**
 * components/PaperSearch/index.tsx
 *
 * "Add a research paper" modal (design/mockup-pdf-layout.html section 03,
 * Slice 07): a centered dialog over a dimmed backdrop with a search input,
 * results merged from OpenAlex + arXiv, and one of three availability
 * states per row:
 *   • open      — direct Import button (primary blue)
 *   • manual    — a free copy exists but every candidate host blocks
 *                 programmatic downloads (blockedHosts): "Open source page"
 *                 outline button + hint to save + upload manually
 *   • paywalled — Lock badge + "View publisher" outline link
 *
 * Search runs debounced (400 ms, ≥3 chars) and on Enter / the Search button.
 * Loading uses the quiet status-text pattern (mockup-search-loading-states
 * L4) plus a button spinner (L9). The parent owns the import — onImport
 * resolves when the PDF is attached; rejections surface inline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen, X, Search, Loader2, Download, ExternalLink, Lock,
} from 'lucide-react';
import { api } from '../../api';
import { allCandidatesBlocked } from './blockedHosts';
import { useStrings } from '../../strings';
import { MathText } from '../MathText';
import type { SearchResult } from '../../types';

type Availability = 'open' | 'manual' | 'paywalled';

function availabilityOf(r: SearchResult): Availability {
  if (!r.open_access_pdf_url) return 'paywalled';
  return allCandidatesBlocked(r.open_access_pdf_url, r.pdf_candidates) ? 'manual' : 'open';
}

interface Props {
  onClose: () => void;
  // Resolves when the paper is attached to the tree (the parent closes the
  // modal). Rejections render as an inline error above the results.
  onImport: (result: SearchResult) => Promise<void>;
}

export function PaperSearchModal({ onClose, onImport }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().paperSearch;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ID der Zeile, deren Import gerade läuft — deaktiviert alle Buttons.
  const [importingId, setImportingId] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runSearch = useCallback(async (q: string) => {
    setSearching(true);
    setError(null);
    try {
      const resp = await api.searchPapers(q);
      setResults(resp.results);
      setRateLimited(resp.rate_limited);
    } catch (e) {
      setResults([]);
      setError(e instanceof Error ? e.message : S.searchFailed);
    } finally {
      setSearching(false);
    }
    // S ist pro Sprache eine stabile Referenz — der Callback bleibt aktuell.
  }, [S]);

  // Debounced search — fires 400 ms after the user stops typing, from 3
  // chars upward (same thresholds as Syflo's home search).
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      setSearching(false);
      setRateLimited(false);
      return;
    }
    debounceTimer.current = setTimeout(() => {
      void runSearch(q);
    }, 400);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, runSearch]);

  const searchNow = () => {
    const q = query.trim();
    if (q.length >= 3) void runSearch(q);
  };

  const handleImport = async (r: SearchResult) => {
    setImportingId(r.id);
    setError(null);
    try {
      await onImport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : S.importFailed);
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paper-search-title"
      data-testid="paper-search-modal"
      data-overlay
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4">
          <h3 id="paper-search-title" className="flex items-center gap-2 text-[15px] font-semibold text-gray-900">
            <BookOpen size={17} className="text-blue-500" />
            {S.title}
          </h3>
          <button
            onClick={onClose}
            aria-label={S.close}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-[12.5px] text-gray-500 px-5 pt-1">
          {S.subtitle}
        </p>

        {/* Search row */}
        <div className="flex items-center gap-2 px-5 py-3">
          <div className="flex-1 flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/15">
            <Search size={16} className="text-gray-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') searchNow(); }}
              placeholder={S.placeholder}
              className="flex-1 min-w-0 text-sm text-gray-900 outline-none placeholder:text-gray-400"
              data-testid="paper-search-input"
            />
          </div>
          <button
            onClick={searchNow}
            disabled={searching || query.trim().length < 3}
            className="px-3.5 py-2 rounded-xl text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            data-testid="paper-search-submit"
          >
            {searching && <Loader2 size={13} className="animate-spin" />}
            {S.search}
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {error && (
            <div className="mx-2 mb-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" data-testid="paper-search-error">
              {error}
            </div>
          )}
          {rateLimited && (
            <div className="mx-2 mb-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" data-testid="paper-search-rate-limited">
              {S.rateLimited}
            </div>
          )}
          {/* Status auch, wenn die vorherige Suche leer war — eine noch
              sichtbare Trefferliste bleibt dagegen ruhig stehen (L4). */}
          {searching && (results === null || results.length === 0) && (
            <p className="text-[13px] text-gray-400 text-center py-6" data-testid="paper-search-status">
              {S.searching}
            </p>
          )}
          {/* !searching: "No results." beschreibt nur die AKTUELLE Suche —
              nie als abgestandener Rest über einer laufenden (Bug 2026-07-24). */}
          {!searching && results !== null && results.length === 0 && !rateLimited && !error && (
            <p className="text-[13px] text-gray-400 text-center py-6">{S.noResults}</p>
          )}
          {results !== null && results.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {results.map((r) => {
                const availability = availabilityOf(r);
                const doiHref = r.doi ? `https://doi.org/${r.doi}` : r.open_access_pdf_url;
                const importing = importingId === r.id;
                return (
                  <li
                    key={r.id}
                    data-testid={`paper-search-result-${r.id}`}
                    className="px-2 py-3 grid grid-cols-[1fr_auto] gap-4 items-center"
                  >
                    <div className="min-w-0">
                      {/* arXiv titles routinely carry $…$ math (audit 2026-07-28) */}
                      <h4 className="text-sm font-semibold text-gray-900 leading-tight"><MathText text={r.title} /></h4>
                      <p className="text-xs text-gray-500 mt-0.5 truncate">
                        {r.authors.slice(0, 3).join(', ')}
                        {r.authors.length > 3 ? ' et al.' : ''}
                        {r.year ? ` · ${r.year}` : ''}
                        {S.cites(r.citations.toLocaleString())}
                      </p>
                      {availability === 'open' ? (
                        <span className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-1.5 py-px">
                          <Download size={9} />
                          {S.openAccess}
                        </span>
                      ) : availability === 'manual' ? (
                        <span
                          data-testid="paper-search-badge-manual"
                          className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-1.5 py-px"
                        >
                          <Download size={9} />
                          {S.manualDownload}
                        </span>
                      ) : (
                        <span
                          data-testid="paper-search-badge-paywalled"
                          className="mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-1.5 py-px"
                        >
                          <Lock size={9} />
                          {S.paywalled}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                      {availability === 'open' ? (
                        <button
                          onClick={() => void handleImport(r)}
                          disabled={importingId !== null}
                          data-testid={`paper-search-import-${r.id}`}
                          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-white bg-blue-500 hover:bg-blue-600 px-3 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {importing ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                          {importing ? S.importing : S.importButton}
                        </button>
                      ) : availability === 'manual' ? (
                        <>
                          <a
                            href={doiHref || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="paper-search-open-source-page"
                            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <ExternalLink size={12} />
                            {S.openSourcePage}
                          </a>
                          <span className="text-[10px] text-gray-400 text-right max-w-[180px] leading-snug">
                            {S.manualHint}
                          </span>
                        </>
                      ) : doiHref ? (
                        <a
                          href={doiHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid="paper-search-view-publisher"
                          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-gray-700 border border-gray-200 hover:bg-gray-50 px-3 py-1.5 rounded-lg transition-colors"
                        >
                          <ExternalLink size={12} />
                          {S.viewPublisher}
                        </a>
                      ) : (
                        <span className="text-[12px] text-gray-400 px-2">{S.noPdf}</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
