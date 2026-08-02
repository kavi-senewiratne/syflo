import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRef } from 'react';
import { ChatArea, type ChatAreaHandle } from '../components/ChatArea';
import { CloudSetupNotice } from '../components/ChatArea/CloudSetupNotice';
import type { ChatDetail } from '../types';

const mockChat: ChatDetail = {
  id: '1',
  title: 'Test Chat',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [
    { id: 'm1', chat_id: '1', role: 'user', content: 'Hello there', created_at: new Date().toISOString() },
    { id: 'm2', chat_id: '1', role: 'assistant', content: 'Hi! How can I help?', created_at: new Date().toISOString() },
  ],
  children: [],
};

const defaultProps = {
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

describe('ChatArea', () => {
  beforeEach(() => {
    defaultProps.onSendMessage.mockClear();
    defaultProps.onWordRightClick.mockClear();
  });

  it('shows welcome screen when no chat selected', () => {
    render(<ChatArea chat={null} loading={false} {...defaultProps} />);
    expect(screen.getByText(/How can I help you today/i)).toBeInTheDocument();
  });

  it('renders chat messages', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('Hi! How can I help?')).toBeInTheDocument();
  });

  it('displays chat title', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
    expect(screen.getByText('Test Chat')).toBeInTheDocument();
  });

  it('sends message on Enter key', async () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: 'Hello!' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(defaultProps.onSendMessage).toHaveBeenCalledWith('Hello!', []));
  });

  it('opens the feedback dialog on /feedback instead of sending a message', async () => {
    const onOpenFeedback = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={onOpenFeedback} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/feedback the picker closes too fast' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onOpenFeedback).toHaveBeenCalledWith('the picker closes too fast'));
    expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('');
  });

  it('shows the /feedback suggestion while typing the command word, and opens the dialog on click', async () => {
    const onOpenFeedback = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={onOpenFeedback} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);

    fireEvent.change(textarea, { target: { value: '/fee' } });
    const suggestion = screen.getByTestId('feedback-slash-item');
    expect(suggestion).toBeInTheDocument();

    fireEvent.click(suggestion);
    expect(onOpenFeedback).toHaveBeenCalledWith('');
    expect(textarea).toHaveValue('');
  });

  it('completes to "/feedback " on ArrowUp while the suggestion is shown', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);

    fireEvent.change(textarea, { target: { value: '/fee' } });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });

    expect(textarea).toHaveValue('/feedback ');
  });

  it('highlights the typed "/feedback" word inside the input itself, even after the suggestion popover is gone', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);

    fireEvent.change(textarea, { target: { value: '/feedback ishlj' } });

    const overlay = screen.getByTestId('chat-textarea-highlight');
    expect(overlay).toHaveTextContent('/feedback ishlj');
    expect(overlay.querySelector('span')).toHaveTextContent('/feedback');
    expect(screen.queryByTestId('feedback-slash-item')).not.toBeInTheDocument();
  });

  it('does not highlight a word that only starts with /feedback without a boundary', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);

    fireEvent.change(textarea, { target: { value: '/feedbackxyz' } });

    expect(screen.getByTestId('chat-textarea-highlight').querySelector('span')).toBeNull();
  });

  it('hides the /feedback suggestion once a space is typed (arguments started)', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);

    fireEvent.change(textarea, { target: { value: '/feedback hi' } });
    expect(screen.queryByTestId('feedback-slash-item')).not.toBeInTheDocument();
  });

  it('opens the feedback dialog with empty text for bare /feedback', async () => {
    const onOpenFeedback = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onOpenFeedback={onOpenFeedback} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/feedback' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onOpenFeedback).toHaveBeenCalledWith(''));
  });

  it('does not send empty message', async () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
  });

  it('shows parent_word when chat is a child', () => {
    const childChat = { ...mockChat, parent_word: 'quantum', parent_id: '0' };
    render(<ChatArea chat={childChat} loading={false} {...defaultProps} />);
    expect(screen.getByText(/quantum/i)).toBeInTheDocument();
  });

  // Spec-Änderung 2026-07-21 (Highlights-Drawer, Grill-Entscheidung 5): der
  // Header ist jetzt PERMANENT — auch bei Branch-Chats —, damit der
  // Highlights-Knopf einen festen Ort hat.
  it('zeigt den Header auch bei Branch-Chats (permanenter Header)', () => {
    const childChat = { ...mockChat, parent_word: 'quantum', parent_id: '0' };
    render(<ChatArea chat={childChat} loading={false} {...defaultProps} />);
    expect(screen.getByTestId('chat-header-shell')).toBeInTheDocument();
  });

  it('ruft onToggleHighlights beim Klick auf den Highlights-Knopf im Header', () => {
    const onToggleHighlights = vi.fn();
    render(
      <ChatArea
        chat={mockChat}
        loading={false}
        {...defaultProps}
        onToggleHighlights={onToggleHighlights}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /highlights/i }));
    expect(onToggleHighlights).toHaveBeenCalled();
  });

  it('bietet ohne onToggleHighlights keinen Highlights-Knopf an', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
    expect(screen.queryByRole('button', { name: /highlights/i })).toBeNull();
  });

  it('scrollToMessage scrollt zur Nachricht und lässt die Zeile ~1,5 s aufblinken', () => {
    const scrollIntoView = vi.fn();
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const ref = createRef<ChatAreaHandle>();
    render(<ChatArea ref={ref} chat={mockChat} loading={false} {...defaultProps} />);

    vi.useFakeTimers();
    try {
      act(() => ref.current!.scrollToMessage('m1'));

      expect(scrollIntoView).toHaveBeenCalled();
      const row = screen.getByTestId('message-row-m1');
      // Der Flash startet erst nach Scroll-Ruhe (3 stabile rAF-Frames,
      // Nutzerkorrektur 2026-07-22) — sonst verpasst man das Aufblinken,
      // während die Zeile noch ins Sichtfeld scrollt. In jsdom bleibt
      // scrollTop konstant, also gilt der Scroll nach ~4 Frames als ruhig.
      expect(row).not.toHaveAttribute('data-flash');
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(row).toHaveAttribute('data-flash', 'true');

      act(() => {
        vi.advanceTimersByTime(1600);
      });
      expect(row).not.toHaveAttribute('data-flash');
    } finally {
      vi.useRealTimers();
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('scrollToMessage mit Range scrollt zur Markierung selbst, nicht nur zur Zeile', () => {
    // Bei langen Nachrichten liegt die Markierung sonst außerhalb des
    // Sichtfelds, obwohl die Zeile zentriert wurde (Nutzer-Report 2026-07-22).
    const scrollIntoView = vi.fn();
    const original = window.HTMLElement.prototype.scrollIntoView;
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const longChat: ChatDetail = {
        ...mockChat,
        messages: [
          ...mockChat.messages,
          {
            id: 'm9',
            chat_id: '1',
            role: 'assistant',
            content:
              'Intro paragraph that goes on for a while.\n\nSecond paragraph.\n\nThe marked passage sits far down in a very long message.',
            created_at: new Date().toISOString(),
          },
        ],
      };
      const ref = createRef<ChatAreaHandle>();
      render(<ChatArea ref={ref} chat={longChat} loading={false} {...defaultProps} />);

      const row = screen.getByTestId('message-row-m9');
      const root = row.querySelector('[data-chat-content]')!;
      const text = root.textContent ?? '';
      const start = text.indexOf('marked passage');
      act(() =>
        ref.current!.scrollToMessage('m9', {
          startOffset: start,
          endOffset: start + 'marked passage'.length,
          color: 'green',
        }),
      );

      expect(scrollIntoView).toHaveBeenCalled();
      const target = scrollIntoView.mock.instances.at(-1) as HTMLElement;
      expect(target).not.toBe(row);
      expect(target.textContent).toContain('marked passage');
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('rendert den highlightsDrawer-Slot über dem Chat-Inhalt', () => {
    render(
      <ChatArea
        chat={mockChat}
        loading={false}
        {...defaultProps}
        highlightsDrawer={<div data-testid="drawer-stub">drawer</div>}
      />,
    );
    expect(screen.getByTestId('drawer-stub')).toBeInTheDocument();
    // Chat bleibt gemountet (Scroll-Position/Streaming gehen nicht verloren).
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('truncates a long branched-from quote in the header and mounts a hover tooltip with the full text', async () => {
    // jsdom has no layout — horizontal overflow (scrollWidth > clientWidth)
    // must be mocked for the tooltip to mount.
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollWidth', 'get')
      .mockReturnValue(600);
    const clientSpy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(400);
    try {
      const longWord =
        'establishes a new single-model state-of-the-art BLEU score of 41.8 after training for 3.5 days on eight GPUs';
      const childChat = { ...mockChat, parent_word: longWord, parent_id: '0' };
      render(<ChatArea chat={childChat} loading={false} {...defaultProps} />);

      // The header line stays truncated; the tooltip mounts with the full quote.
      const quote = screen.getByTestId('branched-from-quote');
      expect(quote.className).toContain('truncate');
      const tooltip = await screen.findByTestId('branched-from-tooltip');
      expect(tooltip.textContent).toContain(longWord);
      expect(screen.getByTestId('branched-from-quote').className).toContain('truncate');
      // No chevron/dropdown to toggle anymore — the tooltip is CSS-driven
      // (group-hover/group-focus-within), always mounted once overflowing.
      expect(screen.queryByTestId('branched-from-toggle')).not.toBeInTheDocument();
      expect(screen.queryByTestId('branched-from-dropdown')).not.toBeInTheDocument();
    } finally {
      scrollSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it('does not mount the tooltip when the quote fits on one line', () => {
    const childChat = { ...mockChat, parent_word: 'quantum', parent_id: '0' };
    render(<ChatArea chat={childChat} loading={false} {...defaultProps} />);
    expect(screen.queryByTestId('branched-from-tooltip')).not.toBeInTheDocument();
  });

  it('keeps a branched-from quote on one line even with an embedded hard line break (2026-07-31)', () => {
    // PDF selections falling back to the browser's raw sel.toString() can
    // carry markdown hard-break syntax (line ending in 2+ spaces before \n)
    // from pdf.js's per-line <br> elements — that used to render as a real
    // <br/>, breaking the header out of its single-line layout.
    const childChat = { ...mockChat, parent_word: 'Berechnung der Varianz  \nUnter der Annahme', parent_id: '0' };
    render(<ChatArea chat={childChat} loading={false} {...defaultProps} />);
    const quote = screen.getByTestId('branched-from-quote');
    expect(quote.querySelector('br')).toBeNull();
    expect(quote.textContent).toContain('Berechnung der Varianz');
    expect(quote.textContent).toContain('Unter der Annahme');
  });

  it('renders math in the branched-from quote as KaTeX instead of raw LaTeX (2026-07-26)', () => {
    const childChat = { ...mockChat, parent_word: 'Energie $E(w_t)$ erklärt', parent_id: '0' };
    render(<ChatArea chat={childChat} loading={false} {...defaultProps} />);
    const quote = screen.getByTestId('branched-from-quote');
    // The formula renders as a KaTeX element; the raw delimiters disappear.
    expect(quote.querySelector('.katex')).not.toBeNull();
    expect(quote.textContent).not.toContain('$E(w_t)$');
    expect(quote.textContent).toContain('Energie');
  });

  it('uses the same spacing between all message bubbles', () => {
    const chatWithGroupedMessages: ChatDetail = {
      ...mockChat,
      messages: [
        { id: 'm1', chat_id: '1', role: 'user', content: 'First', created_at: new Date().toISOString() },
        { id: 'm2', chat_id: '1', role: 'user', content: 'Second', created_at: new Date().toISOString() },
        { id: 'm3', chat_id: '1', role: 'assistant', content: 'Third', created_at: new Date().toISOString() },
      ],
    };

    render(<ChatArea chat={chatWithGroupedMessages} loading={false} {...defaultProps} />);

    expect(screen.getByTestId('message-row-m1')).toHaveStyle({ marginTop: '0px' });
    expect(screen.getByTestId('message-row-m2')).toHaveStyle({ marginTop: '2rem' });
    expect(screen.getByTestId('message-row-m3')).toHaveStyle({ marginTop: '2rem' });
  });

  it('centers the content shell and input shell in the chat window', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);

    const headerShell = screen.getByTestId('chat-header-shell');
    const contentShell = screen.getByTestId('chat-content-shell');
    const inputShell = screen.getByTestId('chat-input-shell');
    const headerWrapper = headerShell.parentElement as HTMLElement;
    const contentWrapper = contentShell.parentElement as HTMLElement;
    const inputWrapper = inputShell.parentElement as HTMLElement;

    expect(headerWrapper.className).toContain('justify-center');
    expect(headerShell).toHaveStyle({ width: '46rem', maxWidth: '100%' });
    expect(contentWrapper.className).toContain('justify-center');
    expect(contentShell).toHaveStyle({ width: '46rem', maxWidth: '100%' });
    expect(inputWrapper.className).toContain('justify-center');
    expect(inputShell).toHaveStyle({ width: '46rem', maxWidth: '100%' });
  });

  describe('Anhang-Plus-Menü', () => {
    it('öffnet beim Klick auf Plus ein Menü, nicht direkt den File-Picker', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('attach-plus-button'));
      expect(screen.getByTestId('attach-menu')).toBeInTheDocument();
      expect(screen.getByTestId('attach-menu-files')).toHaveTextContent(/Media/i);
    });

    it('schließt das Menü, wenn man "Media" auswählt', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      fireEvent.click(screen.getByTestId('attach-plus-button'));
      fireEvent.click(screen.getByTestId('attach-menu-files'));
      expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
    });

    it('schließt das Menü beim Klick außerhalb', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      fireEvent.click(screen.getByTestId('attach-plus-button'));
      expect(screen.getByTestId('attach-menu')).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
    });

    it('zeigt "Upload file" und reicht das gewählte PDF an onUploadPdf weiter', () => {
      const onUploadPdf = vi.fn();
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onUploadPdf={onUploadPdf} />);
      fireEvent.click(screen.getByTestId('attach-plus-button'));
      expect(screen.getByTestId('attach-menu-upload-pdf')).toHaveTextContent(/PDF/i);

      fireEvent.click(screen.getByTestId('attach-menu-upload-pdf'));
      // Menü schließt sich; das versteckte PDF-Input nimmt die Datei entgegen.
      expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
      const pdf = new File(['%PDF-1.4'], 'lease.pdf', { type: 'application/pdf' });
      const input = screen.getByTestId('pdf-file-input');
      fireEvent.change(input, { target: { files: [pdf] } });
      expect(onUploadPdf).toHaveBeenCalledWith(pdf);
    });

    it('zeigt "Upload file" nicht ohne onUploadPdf-Handler', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      fireEvent.click(screen.getByTestId('attach-plus-button'));
      expect(screen.queryByTestId('attach-menu-upload-pdf')).not.toBeInTheDocument();
    });
  });

  describe('Drag-and-drop von Dateien ins Eingabefeld', () => {
    // Hilfsobjekt: minimales DataTransfer-Substitut, das jsdom fehlt.
    const dataTransferWith = (files: File[]) => ({
      types: ['Files'],
      files,
      dropEffect: 'none',
    });

    it('zeigt das Drop-Overlay beim Hereinziehen und blendet es beim Verlassen aus', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      const zone = screen.getByTestId('chat-input-dropzone');
      const dt = dataTransferWith([new File(['x'], 'cat.png', { type: 'image/png' })]);

      fireEvent.dragEnter(zone, { dataTransfer: dt });
      expect(screen.getByTestId('chat-drop-overlay')).toBeInTheDocument();

      fireEvent.dragLeave(zone, { dataTransfer: dt });
      expect(screen.queryByTestId('chat-drop-overlay')).not.toBeInTheDocument();
    });

    it('fügt ein gedropptes Bild als Anhang mit @foto-Alias hinzu', async () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      const zone = screen.getByTestId('chat-input-dropzone');
      const dt = dataTransferWith([new File(['x'], 'cat.png', { type: 'image/png' })]);

      fireEvent.dragEnter(zone, { dataTransfer: dt });
      fireEvent.drop(zone, { dataTransfer: dt });

      expect(await screen.findByTestId('attachment-alias')).toHaveTextContent('@foto1');
      // Overlay verschwindet nach dem Drop
      expect(screen.queryByTestId('chat-drop-overlay')).not.toBeInTheDocument();
    });

    it('ignoriert nicht unterstützte Dateitypen beim Drop', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      const zone = screen.getByTestId('chat-input-dropzone');
      const dt = dataTransferWith([new File(['x'], 'app.exe', { type: 'application/octet-stream' })]);

      fireEvent.dragEnter(zone, { dataTransfer: dt });
      fireEvent.drop(zone, { dataTransfer: dt });

      expect(screen.queryByTestId('attachment-alias')).not.toBeInTheDocument();
    });

    it('flackert nicht, wenn der Drag über Kind-Elemente wandert (Tiefenzähler)', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      const zone = screen.getByTestId('chat-input-dropzone');
      const inner = screen.getByTestId('chat-input-shell');
      const dt = dataTransferWith([new File(['x'], 'cat.png', { type: 'image/png' })]);

      fireEvent.dragEnter(zone, { dataTransfer: dt });
      fireEvent.dragEnter(inner, { dataTransfer: dt });
      fireEvent.dragLeave(inner, { dataTransfer: dt });
      // Ein Kind wurde verlassen, die Zone selbst nicht → Overlay bleibt.
      expect(screen.getByTestId('chat-drop-overlay')).toBeInTheDocument();

      fireEvent.dragLeave(zone, { dataTransfer: dt });
      expect(screen.queryByTestId('chat-drop-overlay')).not.toBeInTheDocument();
    });
  });

  describe('Anhang-Alias umbenennen und @-Autocomplete', () => {
    // Hilfsfunktion: simuliert eine vom User ausgewählte Datei.
    const attachFile = (name: string, type: string) => {
      const file = new File(['hello'], name, { type });
      const hiddenInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(hiddenInput, 'files', { value: [file], configurable: true });
      fireEvent.change(hiddenInput);
    };

    it('benennt einen Alias um und aktualisiert auch den Eingabefeld-Text', async () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      attachFile('cat.png', 'image/png');
      // Anfang: @foto1
      const aliasButton = await screen.findByTestId('attachment-alias');
      expect(aliasButton).toHaveTextContent('@foto1');

      // Erst @foto1 ins Eingabefeld einfügen — dann umbenennen.
      const textarea = screen.getByPlaceholderText(/Ask anything/i);
      fireEvent.change(textarea, { target: { value: '@foto1 was ist das?' } });

      fireEvent.click(aliasButton);
      const input = screen.getByTestId('attachment-alias-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '@katze' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      // Chip zeigt neuen Namen
      expect(await screen.findByTestId('attachment-alias')).toHaveTextContent('@katze');
      // Eingabefeld wurde mitgezogen
      expect((textarea as HTMLTextAreaElement).value).toBe('@katze was ist das?');
    });

    it('hängt automatisch _2 an, wenn der gewünschte Alias schon existiert', async () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      // Zwei Bilder hochladen → @foto1, @foto2
      attachFile('a.png', 'image/png');
      attachFile('b.png', 'image/png');
      const aliases = await screen.findAllByTestId('attachment-alias');
      expect(aliases.map(a => a.textContent)).toEqual(['@foto1', '@foto2']);

      // @foto2 → @foto1 umbenennen (Konflikt!) → erwartet @foto1_2
      fireEvent.click(aliases[1]);
      const input = screen.getByTestId('attachment-alias-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '@foto1' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      const after = await screen.findAllByTestId('attachment-alias');
      expect(after.map(a => a.textContent)).toEqual(['@foto1', '@foto1_2']);
    });

    it('stellt @ vor jedem Alias sicher, auch wenn der User es weglässt', async () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      attachFile('a.png', 'image/png');
      const aliasButton = await screen.findByTestId('attachment-alias');

      fireEvent.click(aliasButton);
      const input = screen.getByTestId('attachment-alias-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'kuh' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(await screen.findByTestId('attachment-alias')).toHaveTextContent('@kuh');
    });

    it('Pfeiltasten + Enter wählen einen Vorschlag, statt die Nachricht zu senden', async () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      attachFile('a.png', 'image/png');
      attachFile('b.png', 'image/png');

      const textarea = screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
      // "@" tippen → Dropdown öffnet sich mit @foto1 / @foto2
      fireEvent.change(textarea, { target: { value: '@' } });
      expect(await screen.findByTestId('mention-item-@foto1')).toBeInTheDocument();

      // Pfeil ↓ → @foto2 wird hervorgehoben
      fireEvent.keyDown(textarea, { key: 'ArrowDown' });
      // Enter → wählt @foto2 in den Text und sendet NICHT
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
      expect(textarea.value).toBe('@foto2 ');
    });

    it('Escape schließt das Mention-Dropdown', async () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      attachFile('a.png', 'image/png');

      const textarea = screen.getByPlaceholderText(/Ask anything/i) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: '@' } });
      expect(await screen.findByTestId('mention-item-@foto1')).toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(screen.queryByTestId('mention-item-@foto1')).not.toBeInTheDocument();
    });
  });

  // Leertaste-Halten IM Eingabefeld = Diktat (kurzer Tipp bleibt ein
  // Leerzeichen) + Enter sendet auch ohne fokussiertes Eingabefeld.
  describe('Leertaste-Diktat im Eingabefeld & globales Enter', () => {
    let getUserMedia: ReturnType<typeof vi.fn>;
    let fetchMock: ReturnType<typeof vi.fn>;

    // Gleiches Fake-Recorder-Muster wie in useVoiceInput.test.ts.
    const recorderFactory = () => ({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => ({
        samples: new Float32Array([0.1, 0.2, 0.3]),
        sampleRate: 16000,
      })),
    });

    beforeEach(() => {
      vi.useFakeTimers();
      const fakeTrack = { stop: vi.fn() };
      getUserMedia = vi.fn(async () => ({ getTracks: () => [fakeTrack] }));
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia },
      });
      fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ text: 'hallo welt' }) }));
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      delete (navigator as any).mediaDevices;
    });

    const renderWithVoice = () =>
      render(
        <ChatArea
          chat={mockChat}
          loading={false}
          {...defaultProps}
          voiceRecorderFactory={recorderFactory as any}
        />
      );

    it('startet das Diktat, wenn die Leertaste im Eingabefeld gehalten wird', async () => {
      renderWithVoice();
      const textarea = screen.getByTestId('chat-textarea');
      textarea.focus();

      fireEvent.keyDown(textarea, { key: ' ', code: 'Space' });
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });

      expect(getUserMedia).toHaveBeenCalled();
      expect(screen.getByTestId('voice-waveform-row')).toBeInTheDocument();

      fireEvent.keyUp(textarea, { key: ' ', code: 'Space' });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(screen.queryByTestId('voice-waveform-row')).not.toBeInTheDocument();
    });

    it('ein kurzer Leertasten-Tipp startet KEIN Diktat', async () => {
      renderWithVoice();
      const textarea = screen.getByTestId('chat-textarea');
      textarea.focus();

      fireEvent.keyDown(textarea, { key: ' ', code: 'Space' });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      fireEvent.keyUp(textarea, { key: ' ', code: 'Space' });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('Enter während der Transkription sendet, sobald das Transkript da ist', async () => {
      let resolveFetch!: (v: unknown) => void;
      fetchMock.mockImplementation(() => new Promise(r => { resolveFetch = r; }));
      renderWithVoice();
      const textarea = screen.getByTestId('chat-textarea');
      textarea.focus();

      // Halten → Diktat, Loslassen → Transkription läuft (fetch hängt noch)
      fireEvent.keyDown(textarea, { key: ' ', code: 'Space' });
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      fireEvent.keyUp(textarea, { key: ' ', code: 'Space' });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Enter jetzt = Senden vormerken, noch nichts abschicken
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(defaultProps.onSendMessage).not.toHaveBeenCalled();

      await act(async () => {
        resolveFetch({ ok: true, json: async () => ({ text: 'hallo welt' }) });
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(defaultProps.onSendMessage).toHaveBeenCalledWith('hallo welt', []);
    });

    it('Enter sendet auch, wenn das Eingabefeld nicht fokussiert ist', async () => {
      renderWithVoice();
      const textarea = screen.getByTestId('chat-textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Hallo!' } });
      textarea.blur();

      fireEvent.keyDown(document.body, { key: 'Enter' });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(defaultProps.onSendMessage).toHaveBeenCalledWith('Hallo!', []);
    });

    it('Enter auf einem fokussierten Button sendet NICHT (nativer Klick gewinnt)', async () => {
      renderWithVoice();
      const textarea = screen.getByTestId('chat-textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Hallo!' } });

      const button = screen.getByTestId('attach-plus-button');
      button.focus();
      fireEvent.keyDown(button, { key: 'Enter' });

      expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
    });
  });

  // ─── YouTube Transcript (ADR-0005) ────────────────────────────────────────

  describe('YouTube Transcript im Plus-Menü', () => {
    it('zeigt den Menüpunkt nur mit onOpenYouTubeSearch und öffnet das Modal darüber', () => {
      const onOpenYouTubeSearch = vi.fn();
      render(
        <ChatArea
          chat={mockChat}
          loading={false}
          {...defaultProps}
          onOpenYouTubeSearch={onOpenYouTubeSearch}
        />,
      );

      fireEvent.click(screen.getByTestId('attach-plus-button'));
      const item = screen.getByTestId('attach-menu-youtube-transcript');
      expect(item).toHaveTextContent('YouTube Transcript');

      fireEvent.click(item);
      expect(onOpenYouTubeSearch).toHaveBeenCalled();
      // Menü schließt nach der Auswahl.
      expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
    });

    it('versteckt den Menüpunkt ohne onOpenYouTubeSearch', () => {
      render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
      fireEvent.click(screen.getByTestId('attach-plus-button'));
      expect(screen.queryByTestId('attach-menu-youtube-transcript')).not.toBeInTheDocument();
    });

    it('rendert Quellen-Banner und Transkript-Drawer über die Slot-Props', () => {
      render(
        <ChatArea
          chat={mockChat}
          loading={false}
          {...defaultProps}
          videoBanner={<div data-testid="video-banner-slot" />}
          transcriptDrawer={<div data-testid="transcript-drawer-slot" />}
        />,
      );
      expect(screen.getByTestId('video-banner-slot')).toBeInTheDocument();
      expect(screen.getByTestId('transcript-drawer-slot')).toBeInTheDocument();
    });
  });
});

// ─── Geführter Leerzustand (ADR-0008, Grill 12b) ─────────────────────────────

describe('ChatArea – setupNotice ersetzt den Composer', () => {
  it('rendert die Notiz statt der Composer-Zeile', () => {
    render(
      <ChatArea
        chat={mockChat}
        loading={false}
        {...defaultProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
      />,
    );
    expect(screen.getByTestId('setup-notice-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-textarea')).not.toBeInTheDocument();
  });

  it('rendert ohne setupNotice die normale Composer-Zeile', () => {
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} />);
    expect(screen.getByTestId('chat-textarea')).toBeInTheDocument();
  });
});

describe('CloudSetupNotice', () => {
  // W9 (mockup-model-cost-tiers, 2026-07-30): the notice is a PATH chooser
  // — a fresh install has every provider, so the card offers the three ways
  // (free / own account / fully private) instead of naming one provider.
  // No cost badges: the row titles carry the tier.
  it('bietet die drei Wege an und öffnet Settings mit passender Vorauswahl', () => {
    const onOpenSettings = vi.fn();
    render(<CloudSetupNotice onOpenSettings={onOpenSettings} />);

    const notice = screen.getByTestId('cloud-setup-notice');
    expect(notice).toHaveTextContent('Start for free');
    expect(notice).toHaveTextContent('Gemini Flash or Groq');
    expect(notice).toHaveTextContent('Use your own account');
    expect(notice).toHaveTextContent('Fully private');

    fireEvent.click(screen.getByTestId('setup-path-free'));
    expect(onOpenSettings).toHaveBeenLastCalledWith('gemini');
    fireEvent.click(screen.getByTestId('setup-path-paid'));
    expect(onOpenSettings).toHaveBeenLastCalledWith('openai');
    fireEvent.click(screen.getByTestId('setup-path-local'));
    expect(onOpenSettings).toHaveBeenLastCalledWith('ollama');
  });
});
