/**
 * components/YouTubeSearch/index.tsx
 *
 * "Add a YouTube transcript" modal (design/mockup-youtube-transcript.html
 * section 02, ADR-0005): a centered dialog over a dimmed backdrop with a
 * search input, results from the local SearXNG YouTube engine (thumbnail,
 * title, channel, upload date, duration) and an Add button per row.
 *
 * Search runs debounced (400 ms, ≥3 chars) and on Enter / the Search button
 * — same thresholds as PaperSearchModal. The parent owns the import —
 * onImport resolves when the transcript is attached to the tree; rejections
 * (e.g. a video without captions) surface inline above the results.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
// Lucide führt keine Marken-Icons mehr — TvMinimalPlay ist der Ersatz für
// das YouTube-Icon aus dem Mockup.
import { TvMinimalPlay, X, Search, Loader2, Plus, Play } from 'lucide-react';
import { api } from '../../api';
import { useStrings } from '../../strings';
import type { VideoSearchResult } from '../../types';

interface Props {
  onClose: () => void;
  // Resolves when the transcript is attached to the tree (the parent closes
  // the modal). Rejections render as an inline error above the results.
  onImport: (result: VideoSearchResult) => Promise<void>;
}

export function YouTubeSearchModal({ onClose, onImport }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().youtubeSearch;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VideoSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
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
      setResults(await api.searchYouTube(q));
    } catch (e) {
      setResults([]);
      setError(e instanceof Error ? e.message : S.searchFailed);
    } finally {
      setSearching(false);
    }
    // S ist pro Sprache eine stabile Referenz — der Callback bleibt aktuell.
  }, [S]);

  // Debounced search — fires 400 ms after the user stops typing, from 3
  // chars upward (same thresholds as the paper search).
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      setSearching(false);
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

  const handleImport = async (r: VideoSearchResult) => {
    setImportingId(r.youtube_id);
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
      aria-labelledby="youtube-search-title"
      data-testid="youtube-search-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4">
          <h3 id="youtube-search-title" className="flex items-center gap-2 text-[15px] font-semibold text-gray-900">
            <TvMinimalPlay size={17} className="text-blue-600" />
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
        {/* Eine einzige Erklärzeile — keine Fußzeile (Nutzerwunsch 2026-07-24:
            weniger Text im Modal). */}
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
              data-testid="youtube-search-input"
            />
          </div>
          <button
            onClick={searchNow}
            disabled={searching || query.trim().length < 3}
            className="px-3.5 py-2 rounded-xl text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            data-testid="youtube-search-submit"
          >
            {searching && <Loader2 size={13} className="animate-spin" />}
            {S.search}
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {error && (
            <div className="mx-2 mb-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" data-testid="youtube-search-error">
              {error}
            </div>
          )}
          {/* Status auch, wenn die vorherige Suche leer war; "No results."
              nur für die AKTUELLE Suche — nie als abgestandener Rest über
              einer laufenden (Bug 2026-07-24, wie PaperSearch). */}
          {searching && (results === null || results.length === 0) && (
            <p className="text-[13px] text-gray-400 text-center py-6" data-testid="youtube-search-status">
              {S.searching}
            </p>
          )}
          {!searching && results !== null && results.length === 0 && !error && (
            <p className="text-[13px] text-gray-400 text-center py-6">{S.noResults}</p>
          )}
          {results !== null && results.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {results.map((r) => {
                const importing = importingId === r.youtube_id;
                return (
                  <li
                    key={r.youtube_id}
                    data-testid={`youtube-search-result-${r.youtube_id}`}
                    className="px-2 py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-center"
                  >
                    {/* Thumbnail (Fallback: dunkle Fläche mit Play-Symbol) */}
                    {/* Media surfaces use literal colors, not theme tokens:
                        the dark placeholder and the duration badge must look
                        like video chrome in every theme (Matrix flips
                        gray-800/text-white and would invert them). */}
                    <div className="relative w-[104px] h-[58px] rounded-lg overflow-hidden bg-[#1f2937] shrink-0 flex items-center justify-center">
                      {r.thumbnail_url ? (
                        <img src={r.thumbnail_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <Play size={18} className="text-[#fff]/90" />
                      )}
                      {r.duration && (
                        <span className="absolute right-1 bottom-1 text-[10px] font-medium text-[#fff] bg-black/75 rounded px-1 font-mono">
                          {r.duration}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-sm font-semibold text-gray-900 leading-tight line-clamp-2">{r.title}</h4>
                      <p className="text-xs text-gray-500 mt-0.5 truncate flex items-center gap-1.5">
                        <span className="truncate">{r.channel}</span>
                        {r.published && (
                          <>
                            <span aria-hidden className="w-[3px] h-[3px] rounded-full bg-gray-300 shrink-0" />
                            <span className="shrink-0">{r.published}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => void handleImport(r)}
                      disabled={importingId !== null}
                      data-testid={`youtube-search-import-${r.youtube_id}`}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                    >
                      {importing ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} strokeWidth={2.5} />}
                      {importing ? S.fetching : S.add}
                    </button>
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
