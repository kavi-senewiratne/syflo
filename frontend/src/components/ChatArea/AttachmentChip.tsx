import { Image as ImageIcon, FileText, File as FileIcon, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStrings } from '../../strings';

interface Props {
  alias: string;
  filename: string;
  mimetype: string;
  previewUrl?: string;
  onRemove?: () => void;
  onRename?: (newAlias: string) => void;
  compact?: boolean;
}

function iconFor(mimetype: string) {
  if (mimetype.startsWith('image/')) return ImageIcon;
  if (mimetype.startsWith('text/') || mimetype === 'application/json') return FileText;
  return FileIcon;
}

export function AttachmentChip({ alias, filename, mimetype, previewUrl, onRemove, onRename, compact }: Props) {
  // UI-Texte in der App language — re-rendert beim Sprachwechsel mit.
  const S = useStrings().attachmentChip;
  const Icon = iconFor(mimetype);
  const isImage = mimetype.startsWith('image/');
  const editable = Boolean(onRename);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(alias);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [editing]);

  // Wenn der Alias von außen geändert wird (z. B. Auto-Suffix), Draft synchron halten.
  useEffect(() => {
    if (!editing) setDraft(alias);
  }, [alias, editing]);

  const commit = () => {
    if (!onRename) return;
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === alias) {
      setDraft(alias);
      return;
    }
    onRename(trimmed);
  };

  const cancel = () => {
    setDraft(alias);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  // Kompakte Pillenform — wird im @-Autocomplete-Dropdown verwendet. Unverändert.
  if (compact) {
    return (
      <div className="inline-flex items-center gap-2 bg-gray-100 rounded-full pl-1 pr-2 py-0.5 text-xs text-gray-700 max-w-[16rem]">
        {isImage && previewUrl ? (
          <img
            src={previewUrl}
            alt={filename}
            className="w-5 h-5 rounded-full object-cover shrink-0"
          />
        ) : (
          <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
            <Icon size={11} />
          </span>
        )}
        <span className="font-medium text-blue-600 shrink-0" data-testid="attachment-alias">{alias}</span>
        <span className="truncate text-gray-500">{filename}</span>
      </div>
    );
  }

  // Großes Quadrat-Tile — wird über dem Eingabefeld angezeigt, damit der User
  // auf einen Blick sieht, welche Datei angehängt ist.
  return (
    <div
      className="relative w-24 h-24 rounded-xl border border-gray-200 bg-gray-50 overflow-hidden shadow-sm group"
      title={filename}
    >
      {/* Vorschau-Bereich: füllt die obere Fläche */}
      {isImage && previewUrl ? (
        <img
          src={previewUrl}
          alt={filename}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 text-blue-600 px-1">
          <Icon size={28} />
          <span className="mt-1 text-[10px] text-gray-600 text-center leading-tight line-clamp-2 break-all">
            {filename}
          </span>
        </div>
      )}

      {/* Alias-Label am unteren Rand mit halbtransparentem Hintergrund */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/40 to-transparent px-1.5 pt-3 pb-1">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className="w-full font-medium text-[11px] text-blue-700 bg-white border border-blue-200 rounded px-1 outline-none focus:border-blue-400"
            aria-label={S.renameAlias}
            data-testid="attachment-alias-input"
          />
        ) : (
          <button
            type="button"
            onClick={editable ? () => setEditing(true) : undefined}
            className={`block w-full text-left font-semibold text-[11px] text-[#fff] truncate ${editable ? 'cursor-text hover:underline' : 'cursor-default'}`}
            title={editable ? S.clickToRename(alias) : alias}
            tabIndex={editable ? 0 : -1}
            data-testid="attachment-alias"
          >
            {alias}
          </button>
        )}
      </div>

      {/* X-Button oben rechts, nur sichtbar wenn entfernbar */}
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/50 text-[#fff] hover:bg-black/70 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
          data-tip={S.remove}
          aria-label={S.remove}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
