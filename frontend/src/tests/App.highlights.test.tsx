/**
 * App.highlights.test.tsx
 *
 * Orchestration tests for the highlight flows in App.tsx (Slices 04–06):
 * swatch click persists a highlight, a second pick recolors instead of
 * duplicating, "Open as new chat" creates the branch AND links the
 * highlight, and the actions menu recolors/deletes/opens the linked chat.
 *
 * PdfView is mocked with a stub that exposes buttons to simulate the
 * selection right-click and highlight clicks — real DOM text selection
 * isn't available in jsdom, and the capture math has its own tests
 * (highlightZoom.test.ts, PdfView.test.tsx).
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { _resetLabelsCacheForTests } from '../hooks/useLabels';
import { _resetTreeHighlightsCacheForTests } from '../hooks/useTreeHighlights';
import type { Chat, ChatDetail, Highlight, Paper } from '../types';

vi.mock('../api', () => ({
  TreeHasSourceError: class TreeHasSourceError extends Error {},
  api: {
    getTree: vi.fn(),
    getSettings: vi.fn(),
    warmupChat: vi.fn().mockResolvedValue(undefined),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getOllamaStatus: vi.fn().mockResolvedValue({ reachable: true, models: [] }),
    getQuotaCooldowns: vi.fn().mockResolvedValue([]),
    getUsageSummary: vi.fn().mockResolvedValue({ month: '2026-07', pricesAsOf: '2026-07-30', providers: {}, modelsToday: {} }),
    getRegistry: vi.fn().mockRejectedValue(new Error('none')),
    updateSettings: vi.fn(),
    getChat: vi.fn(),
    getAncestors: vi.fn().mockResolvedValue([]),
    getTreePaper: vi.fn(),
    getTreeVideo: vi.fn().mockResolvedValue(null),
    uploadPaper: vi.fn(),
    createChat: vi.fn(),
    // Default: no title from the model — the branch falls back to the tidied
    // passage, which is what the older tests below expect.
    passageTitle: vi.fn().mockResolvedValue(null),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    sendMessageStream: vi.fn(),
    explainWord: vi.fn(),
    listHighlights: vi.fn(),
    listTreeHighlights: vi.fn(),
    listMessageHighlights: vi.fn(),
    createMessageHighlight: vi.fn(),
    updateMessageHighlight: vi.fn(),
    deleteMessageHighlight: vi.fn(),
    createHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
    getHighlightLabels: vi.fn(),
    setHighlightLabel: vi.fn(),
  },
}));

// Stub-PdfView: reicht die App-Props über Testknöpfe durch. Ein Klick auf
// "simulate-pdf-rightclick" entspricht dem mouseup, das eine Drag-Selektion
// abschließt (kein Rechtsklick mehr nötig, Nutzerwunsch 2026-07-31):
// Selektion erfasst, dann onSelectionFinalized.
// __pdfScrollSpy zeichnet scrollToHighlight-Aufrufe der App auf (Drawer-Sprung).
vi.mock('../components/PdfView', () => {
  const scrollSpy = vi.fn();
  return {
  __pdfScrollSpy: scrollSpy,
  PdfView: (props: {
    highlights?: Highlight[];
    onCaptureHighlight?: (sel: unknown) => void;
    onSelectionFinalized?: (point: { clientX: number; clientY: number }) => void;
    onColorHighlightClick?: (h: Highlight, e: React.MouseEvent) => void;
    ref?: React.Ref<{ scrollToHighlight: (id: string) => void }>;
  }) => {
    if (props.ref && typeof props.ref === 'object') {
      (props.ref as { current: unknown }).current = { scrollToHighlight: scrollSpy };
    }
    return (
    <div data-testid="fake-pdf-view">
      <button
        data-testid="simulate-pdf-rightclick"
        onClick={(e) => {
          props.onCaptureHighlight?.({
            pageNumber: 2,
            text: 'inverse dynamics model',
            rects: [{ left: 50, top: 25, width: 200, height: 12 }],
          });
          props.onSelectionFinalized?.({ clientX: e.clientX, clientY: e.clientY });
        }}
      />
      {(props.highlights ?? []).map((h) => (
        <button
          key={h.id}
          data-testid={`fake-highlight-${h.id}`}
          onClick={(e) => props.onColorHighlightClick?.(h, e)}
        />
      ))}
    </div>
    );
  },
  };
});

import { api } from '../api';
// @ts-expect-error — Spy aus dem PdfView-Mock (nur im Test-Modul vorhanden).
import { __pdfScrollSpy } from '../components/PdfView';

const rootChat: Chat = {
  id: 'c1',
  title: 'Paper chat',
  parent_id: null,
  parent_word: null,
  created_at: '2026-07-11T00:00:00Z',
  children: [],
};
const rootDetail: ChatDetail = { ...rootChat, messages: [], children: [] };

const paper: Paper = {
  id: 'p1',
  title: 'diffusion-policies',
  authors: [],
  uploaded_at: '2026-07-11T00:00:00Z',
  status: 'ready',
  pdf_url: '/api/papers/p1/pdf',
};

const savedHighlight: Highlight = {
  id: 'h1',
  paperId: 'p1',
  color: 'yellow',
  text: 'inverse dynamics model',
  pageNumber: 2,
  rects: [{ left: 50, top: 25, width: 200, height: 12 }],
  chatId: null,
  createdAt: 'x',
  updatedAt: 'x',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetLabelsCacheForTests();
  _resetTreeHighlightsCacheForTests();
  vi.mocked(api.listTreeHighlights).mockResolvedValue([]);
  vi.mocked(api.getTree).mockResolvedValue([rootChat]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockResolvedValue(rootDetail);
  vi.mocked(api.getTreePaper).mockResolvedValue(paper);
  vi.mocked(api.listHighlights).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.explainWord).mockResolvedValue({ explanation: 'A model that maps states to actions.' });
  vi.mocked(api.createHighlight).mockResolvedValue(savedHighlight);
  vi.mocked(api.updateHighlight).mockImplementation(async (_hid, patch) => ({ ...savedHighlight, ...patch }));
  vi.mocked(api.deleteHighlight).mockResolvedValue(undefined);
});

async function openPdfChatAndRightClick() {
  render(<App />);
  await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Paper chat'));
  await waitFor(() => expect(screen.getByTestId('fake-pdf-view')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('simulate-pdf-rightclick'));
  await waitFor(() => expect(screen.getByText(/inverse dynamics model/)).toBeInTheDocument());
}

describe('App — Highlight-Flows (Slices 04–06)', () => {
  it('Rechtsklick auf eine PDF-Selektion öffnet das Popup mit Farbzeile und Definition', async () => {
    await openPdfChatAndRightClick();
    expect(screen.getByTestId('popup-color-section')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/maps states to actions/)).toBeInTheDocument(),
    );
    // Dritter Parameter = chatId des aktiven Chats (KV-Prefix-Sharing,
    // 2026-07-25): explain nutzt den Gesprächs-Cache, statt ihn zu verdrängen.
    expect(api.explainWord).toHaveBeenCalledWith('inverse dynamics model', expect.any(String), 'c1');
  });

  it('Swatch-Klick persistiert das Highlight; zweiter Klick färbt um statt zu duplizieren (Slice 04)', async () => {
    await openPdfChatAndRightClick();
    await waitFor(() => expect(screen.getByText('Agree')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /highlight as agree/i }));
    await waitFor(() =>
      expect(api.createHighlight).toHaveBeenCalledWith('p1', {
        color: 'green',
        text: 'inverse dynamics model',
        pageNumber: 2,
        rects: [{ left: 50, top: 25, width: 200, height: 12 }],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /highlight as question/i }));
    await waitFor(() =>
      expect(api.updateHighlight).toHaveBeenCalledWith('h1', { color: 'pink' }),
    );
    expect(api.createHighlight).toHaveBeenCalledTimes(1);
  });

  it('"Open as new chat" erstellt den Branch und verknüpft das Highlight (Slice 06)', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: 'About: inverse dynamics model', parent_id: 'c1' };
    vi.mocked(api.createChat).mockResolvedValue(branch);
    await openPdfChatAndRightClick();

    fireEvent.click(screen.getByText(/open as new chat/i));
    // 4th arg: PDF-selection branches persist the selection surroundings as
    // parent_context (decision 2026-07-26). Outside a real text layer the
    // popup context falls back to the selection itself.
    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith(
        'inverse dynamics model',
        'c1',
        'inverse dynamics model',
        'inverse dynamics model',
      ),
    );
    // Kein Swatch-Klick vorher → Highlight wird direkt mit chatId angelegt.
    await waitFor(() =>
      expect(api.createHighlight).toHaveBeenCalledWith('p1', expect.objectContaining({
        color: 'yellow',
        chatId: 'c2',
      })),
    );
  });

  // Der Branch trägt SOFORT den fertigen Titel — im Baum darf nie die rohe
  // Passage stehen (Nutzeranforderung 2026-08-02). Die Titel-Abfrage startet
  // beim Öffnen des Popups, der Branch-Klick verwendet ihr Ergebnis.
  it('erstellt den Branch mit dem vom Modell rekonstruierten Formel-Titel', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: '$x^{(k)}$', parent_id: 'c1' };
    vi.mocked(api.createChat).mockResolvedValue(branch);
    vi.mocked(api.passageTitle).mockResolvedValue('$x^{(k)}$');

    await openPdfChatAndRightClick();
    // Die Abfrage läuft, sobald das Popup offen ist — nicht erst beim Klick.
    await waitFor(() => expect(api.passageTitle).toHaveBeenCalledWith('inverse dynamics model'));

    fireEvent.click(screen.getByText(/open as new chat/i));

    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith(
        '$x^{(k)}$',
        'c1',
        // parent_word bleibt die Original-Passage — der Zitat-Text im
        // Branch-Header ist NICHT der Titel.
        'inverse dynamics model',
        'inverse dynamics model',
      ),
    );
  });

  it('nach Swatch-Klick verknüpft "Open as new chat" das vorhandene Highlight statt ein zweites anzulegen', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: 'About: inverse dynamics model', parent_id: 'c1' };
    vi.mocked(api.createChat).mockResolvedValue(branch);
    await openPdfChatAndRightClick();
    await waitFor(() => expect(screen.getByText('Agree')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /highlight as agree/i }));
    await waitFor(() => expect(api.createHighlight).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText(/open as new chat/i));
    await waitFor(() =>
      expect(api.updateHighlight).toHaveBeenCalledWith('h1', { chatId: 'c2' }),
    );
    expect(api.createHighlight).toHaveBeenCalledTimes(1);
  });

  it('Swatch-Klick gefolgt von sofortigem "Open as new chat" (vor Server-Antwort) verknüpft trotzdem nur ein Highlight statt ein zweites unverknüpftes anzulegen', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: 'About: inverse dynamics model', parent_id: 'c1' };
    vi.mocked(api.createChat).mockResolvedValue(branch);

    // Hold the swatch click's createHighlight request open so "Open as new
    // chat" fires while it's still in flight — the exact race reported
    // 2026-07-31 (two overlapping highlights, only one linked to the chat).
    let resolveCreate: (h: Highlight) => void = () => {};
    const pending = new Promise<Highlight>((resolve) => { resolveCreate = resolve; });
    vi.mocked(api.createHighlight).mockReturnValueOnce(pending);

    await openPdfChatAndRightClick();
    await waitFor(() => expect(screen.getByText('Agree')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /highlight as agree/i }));
    fireEvent.click(screen.getByText(/open as new chat/i));
    resolveCreate(savedHighlight);

    await waitFor(() =>
      expect(api.updateHighlight).toHaveBeenCalledWith('h1', { chatId: 'c2' }),
    );
    expect(api.createHighlight).toHaveBeenCalledTimes(1);
  });

  describe('Highlight-Aktionsmenü (Slice 06)', () => {
    async function openMenu(highlight: Highlight = savedHighlight) {
      vi.mocked(api.listHighlights).mockResolvedValue([highlight]);
      render(<App />);
      await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Paper chat'));
      await waitFor(() =>
        expect(screen.getByTestId(`fake-highlight-${highlight.id}`)).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId(`fake-highlight-${highlight.id}`));
      await waitFor(() =>
        expect(screen.getByTestId('highlight-actions-menu')).toBeInTheDocument(),
      );
    }

    it('bietet Umfärben an und patcht die Farbe', async () => {
      await openMenu();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Reference' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Reference' }));
      await waitFor(() =>
        expect(api.updateHighlight).toHaveBeenCalledWith('h1', { color: 'blue' }),
      );
    });

    it('löscht das Highlight, ohne einen Chat anzurühren', async () => {
      await openMenu();
      fireEvent.click(screen.getByText(/delete highlight/i));
      await waitFor(() => expect(api.deleteHighlight).toHaveBeenCalledWith('h1'));
      expect(api.deleteChat).not.toHaveBeenCalled();
      expect(screen.queryByTestId('highlight-actions-menu')).not.toBeInTheDocument();
    });

    it('zeigt "Open linked chat" nur bei verknüpftem Branch und öffnet ihn', async () => {
      await openMenu({ ...savedHighlight, chatId: 'c9' });
      const linkedDetail: ChatDetail = {
        ...rootChat, id: 'c9', title: 'Linked branch', messages: [], children: [],
      };
      vi.mocked(api.getChat).mockResolvedValue(linkedDetail);
      fireEvent.click(screen.getByText(/open linked chat/i));
      await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c9'));
    });

    it('versteckt "Open linked chat" bei unverknüpften Highlights', async () => {
      await openMenu();
      expect(screen.queryByText(/open linked chat/i)).not.toBeInTheDocument();
    });
  });
});

describe('App — Highlights-Drawer (mockup-highlights-overview.html, Variante A)', () => {
  it('Der Highlighter-Knopf im Chat-Header öffnet den Drawer; X schließt ihn', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([
      {
        kind: 'pdf', id: 'h1', color: 'yellow', text: 'inverse dynamics model',
        paperId: 'p1', pageNumber: 2, rects: [{ left: 50, top: 25, width: 200, height: 12 }],
        chatId: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      },
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Paper chat'));
    await waitFor(() => expect(screen.getByTestId('fake-pdf-view')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Highlights' }));
    await waitFor(() => expect(screen.getByTestId('highlights-drawer')).toBeInTheDocument());
    expect(api.listTreeHighlights).toHaveBeenCalledWith('c1');
    expect(await screen.findByText('PDF · p. 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close highlights' }));
    expect(screen.queryByTestId('highlights-drawer')).not.toBeInTheDocument();
  });

  it('Rechtsklick auf eine Drawer-Karte öffnet das Aktions-Menü', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([
      {
        kind: 'pdf', id: 'h1', color: 'yellow', text: 'inverse dynamics model',
        paperId: 'p1', pageNumber: 2, rects: [{ left: 50, top: 25, width: 200, height: 12 }],
        chatId: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      },
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Paper chat'));
    await waitFor(() => expect(screen.getByTestId('fake-pdf-view')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Highlights' }));

    fireEvent.contextMenu(await screen.findByText('PDF · p. 2'), { clientX: 40, clientY: 50 });
    await waitFor(() =>
      expect(screen.getByTestId('highlight-actions-menu')).toBeInTheDocument(),
    );
    expect(screen.getByText(/delete highlight/i)).toBeInTheDocument();
  });

  it('Klick auf eine PDF-Karte scrollt das PDF zum Highlight; der Drawer bleibt offen', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([
      {
        kind: 'pdf', id: 'h1', color: 'yellow', text: 'inverse dynamics model',
        paperId: 'p1', pageNumber: 2, rects: [{ left: 50, top: 25, width: 200, height: 12 }],
        chatId: null, createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
      },
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Paper chat'));
    await waitFor(() => expect(screen.getByTestId('fake-pdf-view')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Highlights' }));

    fireEvent.click(await screen.findByText('PDF · p. 2'));

    expect(__pdfScrollSpy).toHaveBeenCalledWith('h1');
    expect(screen.getByTestId('highlights-drawer')).toBeInTheDocument();
  });

  it('Klick auf eine Chat-Karte wechselt den Branch, schließt den Drawer und blinkt die Nachricht an', async () => {
    const branchChat: Chat = {
      id: 'c2', title: 'entropy bonus', parent_id: 'c1', parent_word: 'entropy',
      created_at: '2026-07-12T00:00:00Z', children: [],
    };
    const branchDetail: ChatDetail = {
      ...branchChat,
      messages: [
        { id: 'mb1', chat_id: 'c2', role: 'assistant', content: 'the entropy bonus is annealed', created_at: '2026-07-12T00:01:00Z' },
      ],
      children: [],
    };
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branchChat] }]);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2' ? branchDetail : rootDetail,
    );
    vi.mocked(api.listTreeHighlights).mockResolvedValue([
      {
        kind: 'chat', id: 'mh1', color: 'orange', text: 'annealed', chatId: 'c2',
        chatTitle: 'entropy bonus', childChatId: null, messageId: 'mb1', startOffset: 22, endOffset: 30,
        createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
      },
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Paper chat'));
    await waitFor(() => expect(screen.getByTestId('fake-pdf-view')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Highlights' }));

    fireEvent.click(await screen.findByText('Chat · entropy bonus'));

    // Branch geladen, Drawer zu — und es blinkt die MARKIERUNG selbst
    // (data-flash-range), nicht mehr die ganze Bubble (Nutzerkorrektur
    // 2026-07-22).
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
    await waitFor(() => expect(screen.getByTestId('message-row-mb1')).toBeInTheDocument());
    expect(screen.queryByTestId('highlights-drawer')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('message-row-mb1')).toHaveAttribute('data-flash-range', 'true'),
    );
    expect(screen.getByTestId('message-row-mb1')).not.toHaveAttribute('data-flash');
  });

  it('Branch-Layout: Klick auf eine Parent-Karte scrollt den Kontext-Pane, der Drawer bleibt offen', async () => {
    const scrollIntoView = vi.fn();
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const branchChat: Chat = {
        id: 'c2', title: 'entropy bonus', parent_id: 'c1', parent_word: 'entropy',
        created_at: '2026-07-12T00:00:00Z', children: [],
      };
      const parentDetail: ChatDetail = {
        ...rootChat,
        messages: [
          { id: 'm1', chat_id: 'c1', role: 'assistant', content: 'entropy is annealed', created_at: '2026-07-11T00:01:00Z' },
        ],
        children: [branchChat],
      };
      const branchDetail: ChatDetail = { ...branchChat, messages: [], children: [] };
      vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branchChat] }]);
      // No PDF on the tree — the parent chat takes the center pane instead.
      vi.mocked(api.getTreePaper).mockResolvedValue(null);
      vi.mocked(api.getChat).mockImplementation(async (id: string) =>
        id === 'c2' ? branchDetail : parentDetail,
      );
      vi.mocked(api.listTreeHighlights).mockResolvedValue([
        {
          kind: 'chat', id: 'mh1', color: 'orange', text: 'annealed', chatId: 'c1',
          chatTitle: 'Paper chat', childChatId: null, messageId: 'm1', startOffset: 11, endOffset: 19,
          createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
        },
      ]);

      render(<App />);
      await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Paper chat'));
      await waitFor(() => expect(screen.getByText('entropy bonus')).toBeInTheDocument());
      fireEvent.click(screen.getByText('entropy bonus'));
      await waitFor(() => expect(screen.getByTestId('parent-msg-m1')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Highlights' }));
      fireEvent.click(await screen.findByText('Chat · Paper chat'));

      // The jump targets the parent chat, which is already visible in the
      // center pane: scroll it there, keep the drawer open, no chat switch.
      expect(screen.getByTestId('highlights-drawer')).toBeInTheDocument();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      const target = scrollIntoView.mock.instances.at(-1) as HTMLElement;
      expect(target).toBe(screen.getByTestId('parent-msg-m1'));
      expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('Branch-Layout: Klick auf den "Branched from"-Link scrollt den Kontext-Pane statt den Chat zu wechseln (2026-07-29)', async () => {
    const scrollIntoView = vi.fn();
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const branchChat: Chat = {
        id: 'c2', title: 'entropy bonus', parent_id: 'c1', parent_word: 'entropy',
        created_at: '2026-07-12T00:00:00Z', children: [],
      };
      const parentDetail: ChatDetail = {
        ...rootChat,
        messages: [
          { id: 'm1', chat_id: 'c1', role: 'assistant', content: 'entropy is annealed', created_at: '2026-07-11T00:01:00Z' },
        ],
        children: [branchChat],
      };
      const branchDetail: ChatDetail = { ...branchChat, messages: [], children: [] };
      vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branchChat] }]);
      // No PDF on the tree — the parent chat takes the center pane instead.
      vi.mocked(api.getTreePaper).mockResolvedValue(null);
      vi.mocked(api.getChat).mockImplementation(async (id: string) =>
        id === 'c2' ? branchDetail : parentDetail,
      );
      // The highlight created on branching, found via the quote text.
      vi.mocked(api.listMessageHighlights).mockResolvedValue([
        {
          id: 'mh1', color: 'orange', text: 'entropy', chatId: 'c1', childChatId: null,
          messageId: 'm1', startOffset: 0, endOffset: 7,
          createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
        },
      ]);

      render(<App />);
      await waitFor(() => expect(screen.getByText('Paper chat')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Paper chat'));
      await waitFor(() => expect(screen.getByText('entropy bonus')).toBeInTheDocument());
      fireEvent.click(screen.getByText('entropy bonus'));
      await waitFor(() => expect(screen.getByTestId('parent-msg-m1')).toBeInTheDocument());
      const callsBefore = vi.mocked(api.getChat).mock.calls.length;

      // The quote link now lives in the chat header (branch header, §01).
      const quote = screen.getByTestId('branched-from-quote');
      fireEvent.click(within(quote).getByRole('link'));

      // The parent pane scrolls to the source message; the branch chat on
      // the right stays open — no chat switch happens.
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      const target = scrollIntoView.mock.instances.at(-1) as HTMLElement;
      expect(target).toBe(screen.getByTestId('parent-msg-m1'));
      expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
      expect(vi.mocked(api.getChat).mock.calls.length).toBe(callsBefore);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
