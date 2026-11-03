/**
 * HtmlSourceApp.test.tsx
 *
 * The wiring of the HTML source into the app (ADR-0013,
 * design/mockup-html-app.html): a tree whose root carries `html_source_id`
 * opens with the page in the middle column and the chat on the right; upload
 * routes by file kind; a second source asks for a new tree; a web page can be
 * loaded; selections and marks travel through the bridge into the existing
 * popup / branch / highlight-menu flows.
 *
 * The API client is mocked; App, ChatArea, HtmlPane and FloatingPopup are real.
 * The iframe content is not: bridge messages are dispatched by hand.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import type { Chat, ChatDetail, HtmlHighlight, HtmlSource, Message } from '../types';

vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 1,
    renderPage: vi.fn().mockResolvedValue(undefined),
    getPageSize: async () => ({ width: 612, height: 792 }),
  }),
}));

vi.mock('../api', () => {
  class TreeHasSourceError extends Error {
    rootChatId: string | null;
    constructor(rootChatId: string | null) {
      super('tree-has-source');
      this.rootChatId = rootChatId;
    }
  }
  class HtmlNoReadableTextError extends Error {}
  return {
    TreeHasSourceError,
    HtmlNoReadableTextError,
    StreamFailedError: class StreamFailedError extends Error {},
    api: {
      getTree: vi.fn(),
      getSettings: vi.fn(),
      warmupChat: vi.fn().mockResolvedValue(undefined),
      getOllamaModels: vi.fn().mockResolvedValue([]),
      getOllamaStatus: vi.fn().mockResolvedValue({ reachable: true, models: [] }),
      getQuotaCooldowns: vi.fn().mockResolvedValue([]),
      getUsageSummary: vi.fn().mockResolvedValue({ month: '2026-09', pricesAsOf: '2026-09-01', providers: {}, modelsToday: {} }),
      getRegistry: vi.fn().mockRejectedValue(new Error('none')),
      updateSettings: vi.fn(),
      getChat: vi.fn(),
      getAncestors: vi.fn().mockResolvedValue([]),
      getTreePaper: vi.fn(),
      getTreeVideo: vi.fn(),
      uploadPaper: vi.fn(),
      createChat: vi.fn(),
      deleteChat: vi.fn().mockResolvedValue(undefined),
      renameChat: vi.fn(),
      sendMessageStream: vi.fn(),
      explainWord: vi.fn(),
      passageTitle: vi.fn().mockResolvedValue({ title: null, quote: null }),
      listHighlights: vi.fn(),
      listMessageHighlights: vi.fn(),
      listTreeHighlights: vi.fn().mockResolvedValue([]),
      getHighlightLabels: vi.fn(),
      listTranscriptHighlights: vi.fn().mockResolvedValue([]),
      // HTML source
      getHtmlSource: vi.fn(),
      uploadHtmlSource: vi.fn(),
      importHtmlFromUrl: vi.fn(),
      retryHtmlFreeze: vi.fn(),
      getHtmlEmbed: vi.fn(),
      listHtmlHighlights: vi.fn(),
      createHtmlHighlight: vi.fn(),
      updateHtmlHighlight: vi.fn(),
      deleteHtmlHighlight: vi.fn(),
    },
  };
});

import { api, TreeHasSourceError, HtmlNoReadableTextError } from '../api';

const ORIGIN = 'http://src-h1.localhost:3001';
const TOKEN = 'tok-1';

const rootChat: Chat = {
  id: 'c1',
  title: 'Underactuated Lernpfad',
  parent_id: null,
  parent_word: null,
  created_at: '2026-09-29T00:00:00Z',
  html_source_id: 'h1',
  children: [],
};

const messages: Message[] = [
  { id: 'm1', chat_id: 'c1', role: 'user', content: 'Erkläre die Gliederung.', created_at: '2026-09-29T00:00:01Z' },
  { id: 'm2', chat_id: 'c1', role: 'assistant', content: 'Die Vorlesung hat vier Teile.', created_at: '2026-09-29T00:00:02Z' },
];
const rootDetail: ChatDetail = { ...rootChat, messages, children: [] };

const unfrozen = [
  { url: 'https://cdnjs.cloudflare.com/mathjax.js', kind: 'script', reason: 'no-internet' },
  { url: 'https://fonts.googleapis.com/plex', kind: 'font', reason: 'no-internet' },
];
const source: HtmlSource = {
  id: 'h1',
  title: 'Underactuated Lernpfad',
  uploaded_at: '2026-09-29T00:00:00Z',
  sections: [{ level: 1, heading: '1 Einführung' }, { level: 2, heading: '1.2 Pendel' }],
  unfrozen,
};

const mark: HtmlHighlight = {
  id: 'k1',
  htmlSourceId: 'h1',
  chatId: null,
  color: 'yellow',
  anchor: { exact: 'Pendel mit Motor', prefix: 'Das ', suffix: ' ist' },
  section: '1.2 Pendel',
  createdAt: '2026-09-29T00:00:03Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTree).mockResolvedValue([rootChat]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockResolvedValue(rootDetail);
  vi.mocked(api.getTreePaper).mockResolvedValue(null);
  vi.mocked(api.getTreeVideo).mockResolvedValue(null);
  vi.mocked(api.listHighlights).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.getHtmlSource).mockResolvedValue(source);
  vi.mocked(api.getHtmlEmbed).mockResolvedValue({ url: `${ORIGIN}/`, origin: ORIGIN, token: TOKEN });
  vi.mocked(api.listHtmlHighlights).mockResolvedValue([]);
  vi.mocked(api.explainWord).mockResolvedValue({ explanation: 'A pendulum with a motor.' });
});

async function openHtmlChat() {
  render(<App />);
  await waitFor(() => expect(screen.getAllByText('Underactuated Lernpfad').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText('Underactuated Lernpfad')[0]);
  await waitFor(() => expect(api.getHtmlSource).toHaveBeenCalledWith('h1'));
  const frame = (await screen.findByTestId('html-source-frame')) as HTMLIFrameElement;
  // The frame exists a render before the pane's message listener and load handling are
  // in place; a message sent in that gap is lost, which made these tests flaky.
  await act(async () => {});
  return frame;
}

function fromPage(frame: HTMLIFrameElement, data: object) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: ORIGIN,
        source: frame.contentWindow,
        data: { source: 'syflo-bridge', token: TOKEN, ...data },
      }),
    );
  });
}

const selectionMsg = {
  type: 'selection',
  text: 'Pendel mit Motor',
  anchor: { exact: 'Pendel mit Motor', prefix: 'Das ', suffix: ' ist' },
  rect: { left: 100, top: 200, width: 80, height: 16 },
};

describe('App — HTML source in the middle column', () => {
  it('opens the tree three-column: the page in the middle, the chat on the right', async () => {
    await openHtmlChat();
    expect(screen.getByTestId('html-pane')).toBeInTheDocument();
    expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
    expect(api.getHtmlEmbed).toHaveBeenCalledWith('h1');
  });

  it('opens a BRANCH of the tree with the same page (the source is bound to the root)', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: 'LQR', parent_id: 'c1', html_source_id: null };
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branch] }]);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2' ? { ...branch, messages: [], children: [] } : rootDetail,
    );
    render(<App />);
    await waitFor(() => expect(screen.getAllByText('Underactuated Lernpfad').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Underactuated Lernpfad')[0]);
    fireEvent.click(await screen.findByText('LQR'));
    await waitFor(() => expect(api.getHtmlSource).toHaveBeenCalledWith('h1'));
    expect(await screen.findByTestId('html-pane')).toBeInTheDocument();
  });

  it('hangs the freeze card under the first answer, lists the reasons, and retry updates it', async () => {
    vi.mocked(api.retryHtmlFreeze).mockResolvedValue({ ...source, unfrozen: [] });
    await openHtmlChat();
    const card = await screen.findByTestId('html-freeze-card');
    expect(card).toHaveTextContent('2 resources not frozen');
    expect(card).toHaveTextContent('mathjax.js (cdnjs.cloudflare.com): no internet');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.retryHtmlFreeze).toHaveBeenCalledWith('h1'));
    await waitFor(() => expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument());
    // The badge in the header goes with it, and the subtitle says why.
    expect(screen.queryByTestId('html-unfrozen-badge')).not.toBeInTheDocument();
    expect(screen.getByText(/fully frozen/)).toBeInTheDocument();
  });

  it('keeps the card and shows the remaining reasons when a retry only partly succeeds', async () => {
    vi.mocked(api.retryHtmlFreeze).mockResolvedValue({ ...source, unfrozen: [unfrozen[1]] });
    await openHtmlChat();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('html-freeze-card')).toHaveTextContent('1 resource not frozen'));
  });

  it('does not show the card under a branch chat (only the root has a "first answer")', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: 'LQR', parent_id: 'c1', html_source_id: null };
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branch] }]);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2'
        ? { ...branch, messages: [{ ...messages[1], id: 'b1', chat_id: 'c2' }], children: [] }
        : rootDetail,
    );
    render(<App />);
    await waitFor(() => expect(screen.getAllByText('Underactuated Lernpfad').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Underactuated Lernpfad')[0]);
    fireEvent.click(await screen.findByText('LQR'));
    await screen.findByTestId('html-pane');
    await waitFor(() => expect(screen.getByText('Die Vorlesung hat vier Teile.')).toBeInTheDocument());
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
  });
});

describe('App — adding an HTML source', () => {
  async function openEmptyChat() {
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, html_source_id: null }]);
    vi.mocked(api.getChat).mockResolvedValue({ ...rootDetail, html_source_id: null, messages: [] });
    render(<App />);
    await waitFor(() => expect(screen.getAllByText('Underactuated Lernpfad').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Underactuated Lernpfad')[0]);
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c1'));
    // The request resolving is not the chat being on screen — the slow CI
    // runners render it a tick later (release runs 2026-11-02/03).
    await screen.findByTestId('chat-textarea');
  }

  const pickFile = (file: File) => {
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    fireEvent.click(screen.getByTestId('attach-menu-upload-pdf'));
    fireEvent.change(screen.getByTestId('pdf-file-input'), { target: { files: [file] } });
  };

  it('routes an .html file to the HTML upload, not the paper upload, and opens the page', async () => {
    vi.mocked(api.uploadHtmlSource).mockResolvedValue(source);
    await openEmptyChat();
    const file = new File(['<html></html>'], 'lernpfad.html', { type: 'text/html' });
    pickFile(file);
    await waitFor(() => expect(api.uploadHtmlSource).toHaveBeenCalledWith('c1', file));
    expect(api.uploadPaper).not.toHaveBeenCalled();
    expect(await screen.findByTestId('html-pane')).toBeInTheDocument();
    // No separate import note (every source loads the same way): the outcome is
    // the page itself, whose header badge counts what was not frozen.
    expect(screen.queryByTestId('html-import-note')).not.toBeInTheDocument();
    expect(await screen.findByTestId('html-unfrozen-badge')).toHaveTextContent('2 open');
  });

  it('routes by extension when the browser gives no MIME type', async () => {
    vi.mocked(api.uploadHtmlSource).mockResolvedValue({ ...source, unfrozen: [] });
    await openEmptyChat();
    const file = new File(['<html></html>'], 'seite.htm', { type: '' });
    pickFile(file);
    await waitFor(() => expect(api.uploadHtmlSource).toHaveBeenCalledWith('c1', file));
  });

  it('still routes a PDF to the paper upload', async () => {
    vi.mocked(api.uploadPaper).mockResolvedValue({
      id: 'p1', title: 't', authors: [], uploaded_at: '', status: 'ready', pdf_url: '/api/papers/p1/pdf',
    });
    await openEmptyChat();
    const pdf = new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' });
    pickFile(pdf);
    await waitFor(() => expect(api.uploadPaper).toHaveBeenCalledWith('c1', pdf));
    expect(api.uploadHtmlSource).not.toHaveBeenCalled();
  });

  it('a second source asks for a new tree, names the HTML source, and confirming imports it there', async () => {
    vi.mocked(api.uploadHtmlSource)
      .mockRejectedValueOnce(new TreeHasSourceError('c1'))
      .mockResolvedValueOnce({ ...source, id: 'h2', unfrozen: [] });
    vi.mocked(api.createChat).mockResolvedValue({ ...rootChat, id: 'c9', title: 'New Chat', html_source_id: null });
    await openHtmlChat();
    const file = new File(['<html></html>'], 'zweite.html', { type: 'text/html' });
    pickFile(file);

    expect(await screen.findByText('This chat tree already has a source')).toBeInTheDocument();
    // The source already in the tree is the HTML page; the new one is HTML too.
    expect(screen.getByText('In this tree')).toBeInTheDocument();
    expect(screen.getByTestId('new-tree-next-source')).toHaveTextContent('zweite.html');
    expect(screen.getByTestId('new-tree-next-source')).toHaveTextContent('HTML');

    fireEvent.click(screen.getByRole('button', { name: 'Start new tree' }));
    await waitFor(() => expect(api.uploadHtmlSource).toHaveBeenLastCalledWith('c9', file));
  });
});

describe('App — loading a web page', () => {
  async function openEmptyChat() {
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, html_source_id: null }]);
    vi.mocked(api.getChat).mockResolvedValue({ ...rootDetail, html_source_id: null, messages: [] });
    render(<App />);
    await waitFor(() => expect(screen.getAllByText('Underactuated Lernpfad').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Underactuated Lernpfad')[0]);
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c1'));
    // The request resolving is not the chat being on screen — the slow CI
    // runners render it a tick later (release runs 2026-11-02/03).
    await screen.findByTestId('chat-textarea');
  }

  const openDialog = () => {
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    fireEvent.click(screen.getByTestId('attach-menu-webpage'));
  };
  const load = (url: string) => {
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  };

  it('imports the address, closes the dialog and opens the page', async () => {
    vi.mocked(api.importHtmlFromUrl).mockResolvedValue({ ...source, unfrozen: [] });
    await openEmptyChat();
    openDialog();
    load('https://example.org/article');
    await waitFor(() => expect(api.importHtmlFromUrl).toHaveBeenCalledWith('c1', 'https://example.org/article'));
    expect(await screen.findByTestId('html-pane')).toBeInTheDocument();
    expect(screen.queryByTestId('html-web-dialog')).not.toBeInTheDocument();
  });

  it('answers a page without readable text with the quiet hint and an upload exit that uploads the file', async () => {
    vi.mocked(api.importHtmlFromUrl).mockRejectedValue(new HtmlNoReadableTextError());
    vi.mocked(api.uploadHtmlSource).mockResolvedValue({ ...source, unfrozen: [] });
    await openEmptyChat();
    openDialog();
    load('https://example.org/login');
    expect(await screen.findByTestId('html-web-no-text')).toBeInTheDocument();
    const file = new File(['<html></html>'], 'saved.html', { type: 'text/html' });
    fireEvent.change(screen.getByTestId('html-web-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadHtmlSource).toHaveBeenCalledWith('c1', file));
    await waitFor(() => expect(screen.queryByTestId('html-web-dialog')).not.toBeInTheDocument());
  });

  it('a second source from a URL asks for a new tree, and confirming imports the URL there', async () => {
    vi.mocked(api.importHtmlFromUrl)
      .mockRejectedValueOnce(new TreeHasSourceError('c1'))
      .mockResolvedValueOnce({ ...source, id: 'h2', unfrozen: [] });
    vi.mocked(api.createChat).mockResolvedValue({ ...rootChat, id: 'c9', title: 'New Chat', html_source_id: null });
    await openHtmlChat();
    openDialog();
    load('https://example.org/second');
    expect(await screen.findByText('This chat tree already has a source')).toBeInTheDocument();
    expect(screen.queryByTestId('html-web-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-tree-next-source')).toHaveTextContent('https://example.org/second');
    fireEvent.click(screen.getByRole('button', { name: 'Start new tree' }));
    await waitFor(() => expect(api.importHtmlFromUrl).toHaveBeenLastCalledWith('c9', 'https://example.org/second'));
  });
});

describe('App — selections and marks through the bridge', () => {
  it('a selection in the page opens the usual popup with the colors and "Ask in chat"', async () => {
    const frame = await openHtmlChat();
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    fromPage(frame, selectionMsg);
    expect(await screen.findByTestId('popup-color-section')).toBeInTheDocument();
    expect(screen.getByTestId('popup-ask-in-chat')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/A pendulum with a motor/)).toBeInTheDocument());
    expect(api.explainWord).toHaveBeenCalledWith('Pendel mit Motor', expect.any(String), 'c1');
  });

  it('a color pick saves the quote anchor with its section; a second pick recolors', async () => {
    vi.mocked(api.createHtmlHighlight).mockResolvedValue({ ...mark, color: 'green' });
    vi.mocked(api.updateHtmlHighlight).mockResolvedValue({ ...mark, color: 'pink' });
    const frame = await openHtmlChat();
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    fromPage(frame, selectionMsg);
    await waitFor(() => expect(screen.getByText('Agree')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /highlight as agree/i }));
    await waitFor(() =>
      expect(api.createHtmlHighlight).toHaveBeenCalledWith('h1', {
        color: 'green',
        anchor: selectionMsg.anchor,
        section: '1.2 Pendel',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /highlight as question/i }));
    await waitFor(() => expect(api.updateHtmlHighlight).toHaveBeenCalledWith('k1', { color: 'pink' }));
    expect(api.createHtmlHighlight).toHaveBeenCalledTimes(1);
  });

  it('paints the stored marks into the page once the bridge is ready', async () => {
    vi.mocked(api.listHtmlHighlights).mockResolvedValue([mark]);
    const frame = await openHtmlChat();
    await waitFor(() => expect(api.listHtmlHighlights).toHaveBeenCalledWith('h1'));
    const post = vi.fn();
    Object.defineProperty(frame.contentWindow, 'postMessage', { value: post, configurable: true });
    fromPage(frame, { type: 'ready' });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'set-highlights', highlights: [{ id: 'k1', color: 'yellow', anchor: mark.anchor }] }),
      ORIGIN,
    );
  });

  it('"Ask in chat" drops the passage into the composer, titled with the source, anchored to the mark', async () => {
    vi.mocked(api.createHtmlHighlight).mockResolvedValue({ ...mark, color: 'green' });
    const frame = await openHtmlChat();
    fromPage(frame, selectionMsg);
    await waitFor(() => expect(screen.getByText('Agree')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /highlight as agree/i }));
    await waitFor(() => expect(api.createHtmlHighlight).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('popup-ask-in-chat'));
    const quote = await screen.findByTestId('composer-quote');
    expect(quote).toHaveTextContent('Pendel mit Motor');
    expect(quote).toHaveTextContent('Underactuated Lernpfad');
  });

  it('"Ask in chat" without a color pick still marks the passage (chat parity: a quote must be able to jump back)', async () => {
    vi.mocked(api.createHtmlHighlight).mockResolvedValue(mark);
    const frame = await openHtmlChat();
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    fromPage(frame, selectionMsg);
    fireEvent.click(await screen.findByTestId('popup-ask-in-chat'));
    await waitFor(() =>
      expect(api.createHtmlHighlight).toHaveBeenCalledWith('h1', {
        color: 'yellow',
        anchor: selectionMsg.anchor,
        section: '1.2 Pendel',
      }),
    );
  });

  it('"Open as new chat" branches from the ROOT with the passage and links the mark to the branch', async () => {
    const branch: Chat = { ...rootChat, id: 'c2', title: 'Pendel mit Motor', parent_id: 'c1', html_source_id: null };
    vi.mocked(api.createChat).mockResolvedValue(branch);
    vi.mocked(api.createHtmlHighlight).mockResolvedValue({ ...mark, chatId: 'c2' });
    const frame = await openHtmlChat();
    fromPage(frame, { type: 'section', heading: '1.2 Pendel', index: 1 });
    fromPage(frame, selectionMsg);
    fireEvent.click(await screen.findByText(/open as new chat/i));

    await waitFor(() =>
      expect(api.createChat).toHaveBeenCalledWith(
        'Pendel mit Motor',
        'c1',
        'Pendel mit Motor',
        // The bridge's context stands in for the PDF's surrounding lines.
        'Das Pendel mit Motor ist',
        undefined,
      ),
    );
    await waitFor(() =>
      expect(api.createHtmlHighlight).toHaveBeenCalledWith('h1', {
        color: 'yellow',
        anchor: selectionMsg.anchor,
        section: '1.2 Pendel',
        chatId: 'c2',
      }),
    );
  });

  it('a click on a mark opens the actions menu; recolor, delete and the linked chat work', async () => {
    const linked: HtmlHighlight = { ...mark, chatId: 'c2' };
    vi.mocked(api.listHtmlHighlights).mockResolvedValue([linked]);
    vi.mocked(api.updateHtmlHighlight).mockResolvedValue({ ...linked, color: 'blue' });
    const frame = await openHtmlChat();
    await waitFor(() => expect(api.listHtmlHighlights).toHaveBeenCalled());

    fromPage(frame, { type: 'highlight-click', id: 'k1', rect: { left: 10, top: 20, width: 40, height: 14 } });
    expect(await screen.findByText('Change color')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Reference/ }));
    await waitFor(() => expect(api.updateHtmlHighlight).toHaveBeenCalledWith('k1', { color: 'blue' }));

    fireEvent.click(screen.getByText('Delete highlight'));
    await waitFor(() => expect(api.deleteHtmlHighlight).toHaveBeenCalledWith('k1'));
  });

  it('the linked chat of a mark opens from the menu', async () => {
    vi.mocked(api.listHtmlHighlights).mockResolvedValue([{ ...mark, chatId: 'c2' }]);
    const frame = await openHtmlChat();
    await waitFor(() => expect(api.listHtmlHighlights).toHaveBeenCalled());
    fromPage(frame, { type: 'highlight-click', id: 'k1', rect: { left: 10, top: 20, width: 40, height: 14 } });
    fireEvent.click(await screen.findByText('Open linked chat'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
    // The request resolving is not the chat being on screen — the slow CI
    // runners render it a tick later (release runs 2026-11-02/03).
    await screen.findByTestId('chat-textarea');
  });

  it('a click on a quote in a sent message scrolls the page to the passage', async () => {
    vi.mocked(api.listHtmlHighlights).mockResolvedValue([mark]);
    vi.mocked(api.getChat).mockResolvedValue({
      ...rootDetail,
      messages: [
        { ...messages[0], content: '> Pendel mit Motor\n\nWas ist das?', quote_highlight_id: 'k1' },
        messages[1],
      ],
    });
    const frame = await openHtmlChat();
    await waitFor(() => expect(api.listHtmlHighlights).toHaveBeenCalled());
    const post = vi.fn();
    Object.defineProperty(frame.contentWindow, 'postMessage', { value: post, configurable: true });
    fromPage(frame, { type: 'ready' });
    post.mockClear();

    const quote = await screen.findByTestId('user-message-quote');
    fireEvent.click(quote);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'scroll-to-anchor', anchor: mark.anchor }),
        ORIGIN,
      ),
    );
  });
});
