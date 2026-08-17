/**
 * VideoPaneApp.test.tsx
 *
 * The wiring of the video pane into the app (variant C,
 * design/mockup-youtube-embed-layout.html): a tree whose source is a YouTube
 * transcript opens in the same three-column shape as a PDF tree — video in the
 * middle, chat on the right — and a time mark in the chat jumps in that player
 * instead of leaving for YouTube.
 *
 * The API client is mocked; App, ChatArea and VideoPane are real.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import type { Chat, ChatDetail, Message, Video } from '../types';

vi.mock('../pdf/pdfDocument', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 1,
    renderPage: vi.fn().mockResolvedValue(undefined),
    getPageSize: async () => ({ width: 612, height: 792 }),
  }),
}));

vi.mock('../api', () => ({
  TreeHasSourceError: class TreeHasSourceError extends Error {
    rootChatId: string | null;
    constructor(rootChatId: string | null) {
      super('tree-has-source');
      this.rootChatId = rootChatId;
    }
  },
  StreamFailedError: class StreamFailedError extends Error {},
  api: {
    getTree: vi.fn(),
    getSettings: vi.fn(),
    warmupChat: vi.fn().mockResolvedValue(undefined),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getOllamaStatus: vi.fn().mockResolvedValue({ reachable: true, models: [] }),
    getQuotaCooldowns: vi.fn().mockResolvedValue([]),
    getUsageSummary: vi.fn().mockResolvedValue({ month: '2026-08', pricesAsOf: '2026-08-15', providers: {}, modelsToday: {} }),
    getRegistry: vi.fn().mockRejectedValue(new Error('none')),
    updateSettings: vi.fn(),
    getChat: vi.fn(),
    getAncestors: vi.fn().mockResolvedValue([]),
    getTreePaper: vi.fn(),
    uploadPaper: vi.fn(),
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    renameChat: vi.fn(),
    sendMessageStream: vi.fn(),
    regenerateMessage: vi.fn(),
    continueMessage: vi.fn(),
    listTranscriptHighlights: vi.fn().mockResolvedValue([]),
    createTranscriptHighlight: vi.fn(),
    updateTranscriptHighlight: vi.fn(),
    deleteTranscriptHighlight: vi.fn(),
    explainWord: vi.fn(),
    listHighlights: vi.fn(),
    listMessageHighlights: vi.fn(),
    createMessageHighlight: vi.fn(),
    updateMessageHighlight: vi.fn(),
    deleteMessageHighlight: vi.fn(),
    createHighlight: vi.fn(),
    updateHighlight: vi.fn(),
    deleteHighlight: vi.fn(),
    getHighlightLabels: vi.fn(),
    setHighlightLabel: vi.fn(),
    searchPapers: vi.fn(),
    importPaperFromUrl: vi.fn(),
    searchYouTube: vi.fn(),
    importYouTubeVideo: vi.fn(),
    getTreeVideo: vi.fn(),
  },
}));

import { api } from '../api';

const rootChat: Chat = {
  id: 'c1',
  title: 'Intro to Large Language Models',
  parent_id: null,
  parent_word: null,
  created_at: '2026-08-15T00:00:00Z',
  children: [],
};

const OVERVIEW = `## An LLM is two files [0:00 - 7:30]

**A model you can hold in your hand.**

- **parameters.bin**: 140 GB.

## Where the parameters come from [8:58 - 14:14]

**Pre-training compresses the internet.**

- **Cost**: ~$2 M.
`;

const messages: Message[] = [
  {
    id: 'm1',
    chat_id: 'c1',
    role: 'user',
    content: 'Break the whole video into its sections.',
    created_at: '2026-08-15T00:00:01Z',
  },
  {
    id: 'm2',
    chat_id: 'c1',
    role: 'assistant',
    content: OVERVIEW,
    created_at: '2026-08-15T00:00:02Z',
  },
];

const rootDetail: ChatDetail = { ...rootChat, messages, children: [] };

const video: Video = {
  id: 'v1',
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration_seconds: 3587,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  transcript: '[00:00] Hi everyone.\n\n[08:58] A kind of zip file of the internet.',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getTree).mockResolvedValue([rootChat]);
  vi.mocked(api.getSettings).mockRejectedValue(new Error('none'));
  vi.mocked(api.getChat).mockResolvedValue(rootDetail);
  vi.mocked(api.getTreePaper).mockResolvedValue(null);
  vi.mocked(api.getTreeVideo).mockResolvedValue(video);
  vi.mocked(api.listHighlights).mockResolvedValue([]);
  vi.mocked(api.listMessageHighlights).mockResolvedValue([]);
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
});

async function openVideoChat() {
  render(<App />);
  await waitFor(() => expect(screen.getAllByText('Intro to Large Language Models').length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText('Intro to Large Language Models')[0]);
  await waitFor(() => expect(api.getTreeVideo).toHaveBeenCalledWith('c1'));
}

describe('App — video pane in the middle column', () => {
  it('öffnet den Baum dreispaltig: Video in der Mitte, Chat rechts', async () => {
    await openVideoChat();

    await waitFor(() => expect(screen.getByTestId('video-pane')).toBeInTheDocument());
    expect(screen.getByTestId('chat-pane-right')).toBeInTheDocument();
    // Das schlanke Banner entfällt: Titel, Kanal und Dauer stehen jetzt in der
    // Werkzeugleiste der Mittelspalte (Mockup §01).
    expect(screen.queryByTestId('video-banner')).not.toBeInTheDocument();
  });

  it('zeigt die Kapitel der Übersicht unter dem Player', async () => {
    await openVideoChat();

    await waitFor(() => expect(screen.getByTestId('video-chapters')).toBeInTheDocument());
    const rows = screen.getAllByTestId('video-chapter');
    expect(rows).toHaveLength(2);
    // Die Überschrift steht bewusst zweimal: links als Kapitel, rechts in der
    // Antwort. Hier wird die Kapitelzeile geprüft.
    expect(rows[0]).toHaveTextContent('An LLM is two files');
    expect(rows[1]).toHaveTextContent('Where the parameters come from');
  });

  it('springt im eingebetteten Player, wenn man eine Zeitmarke im Chat klickt', async () => {
    await openVideoChat();
    await waitFor(() => expect(screen.getByTestId('video-player-frame')).toBeInTheDocument());

    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    // Der Player muss schon gelaufen sein, damit gesprungen wird: solange er
    // nie gespielt hat, bekommt er die Stelle über seine `start`-Sekunde und
    // bleibt stehen (Nutzerwunsch 2026-08-16, „das Video soll der Nutzer
    // starten").
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.youtube.com',
        data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1, currentTime: 3 } }),
      }),
    );

    // Die Marke der zweiten Überschrift: [8:58 - 14:14] → 538 s, minus Vorlauf.
    const marks = screen.getAllByTestId('video-time-link');
    fireEvent.click(marks[marks.length - 1]);

    const sent = post.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(sent).toContainEqual({ event: 'command', func: 'seekTo', args: [536, true] });
  });
});

// ─── Die Pane kennt den Zustand der Übersicht ──────────────────────────────
// design/mockup-truncated-answer.html §02: die Kapitelliste sagt, wenn die
// Übersicht abbrach — und bietet dort den Ausweg an, wo die Lücke auffällt.

describe('App — chapter list mirrors the state of the overview', () => {
  it('shows the cut-off card and continues the overview from the pane', async () => {
    const cutMessages: Message[] = [
      messages[0],
      { ...messages[1], content: '## An LLM is two files [0:00 - 7:30]\n\n**A model.**\n\n- **parameters.bin**: 140 GB, und dann', truncated: 1 },
    ];
    vi.mocked(api.getChat).mockResolvedValue({ ...rootDetail, messages: cutMessages });
    vi.mocked(api.continueMessage).mockImplementation(() => new Promise(() => {}));

    await openVideoChat();

    const note = await screen.findByTestId('video-chapters-truncated');
    expect(note).toHaveTextContent('7:30');

    fireEvent.click(screen.getByTestId('video-continue-button'));
    await waitFor(() =>
      expect(api.continueMessage).toHaveBeenCalledWith('c1', 'm2', expect.any(Function), expect.anything()),
    );
  });

  it('keeps quiet when the overview is complete', async () => {
    await openVideoChat();
    await screen.findByTestId('video-chapters');
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });
});

// ─── Markieren im Transcript → Zweig ───────────────────────────────────────
// design/mockup-transcript-selection.html, Variante A: die markierte Passage
// geht durch dasselbe Popup wie Chat- und PDF-Auswahl.

function mockSelectionOver(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => range.toString(),
  } as unknown as Selection);
  return range;
}

describe('App — selecting in the transcript', () => {
  it('opens the known popup and branches from the passage', async () => {
    vi.mocked(api.explainWord).mockResolvedValue({ explanation: 'Eine Erklärung.' });
    vi.mocked(api.createChat).mockResolvedValue({
      id: 'c2', title: 'Über …', parent_id: 'c1', parent_word: 'zip file of the internet',
      created_at: '2026-08-16T00:00:00Z', children: [],
    });

    await openVideoChat();
    fireEvent.click(await screen.findByTestId('video-view-transcript'));

    const block = screen.getAllByTestId('video-transcript-block')[1];
    const textNode = block.querySelector('[data-transcript-text]')!.firstChild!;
    mockSelectionOver(textNode, 2, 20);
    fireEvent.mouseUp(block);

    // Same popup as everywhere else — it explains the passage first.
    await waitFor(() => expect(api.explainWord).toHaveBeenCalled());
    const passage = vi.mocked(api.explainWord).mock.calls[0][0];
    expect(passage.length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByTestId('popup-open-child-chat'));

    await waitFor(() => expect(api.createChat).toHaveBeenCalled());
    const [, parentId, parentWord] = vi.mocked(api.createChat).mock.calls[0];
    // The transcript hangs on the tree ROOT (ADR-0005), so the branch does too.
    expect(parentId).toBe('c1');
    expect(parentWord).toBe(passage);
  });
});

describe('App — quoting the transcript into the chat', () => {
  it('drops the passage into the composer with its time as the source', async () => {
    vi.mocked(api.explainWord).mockResolvedValue({ explanation: 'Eine Erklärung.' });

    await openVideoChat();
    fireEvent.click(await screen.findByTestId('video-view-transcript'));

    const block = screen.getAllByTestId('video-transcript-block')[1];
    const textNode = block.querySelector('[data-transcript-text]')!.firstChild!;
    mockSelectionOver(textNode, 2, 20);
    fireEvent.mouseUp(block);

    await waitFor(() => expect(api.explainWord).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('popup-ask-in-chat'));

    const quote = await screen.findByTestId('composer-quote');
    // The source line names the moment, not just "the video" — that time is
    // what the way back uses.
    expect(quote).toHaveTextContent('8:58');
  });
});

describe('App — coloring a transcript passage', () => {
  it('saves the mark against the video, with its offsets and second', async () => {
    vi.mocked(api.explainWord).mockResolvedValue({ explanation: 'Eine Erklärung.' });
    vi.mocked(api.createTranscriptHighlight).mockResolvedValue({
      id: 'th1', videoId: 'v1', color: 'yellow', text: 'kind of zip file',
      startOffset: 10, endOffset: 26, startSeconds: 538, childChatId: null,
      createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
    });

    await openVideoChat();
    fireEvent.click(await screen.findByTestId('video-view-transcript'));

    const block = screen.getAllByTestId('video-transcript-block')[1];
    const textNode = block.querySelector('[data-transcript-text]')!.firstChild!;
    mockSelectionOver(textNode, 2, 20);
    fireEvent.mouseUp(block);
    await waitFor(() => expect(api.explainWord).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('popup-color-yellow'));

    await waitFor(() => expect(api.createTranscriptHighlight).toHaveBeenCalled());
    const [videoId, payload] = vi.mocked(api.createTranscriptHighlight).mock.calls[0];
    expect(videoId).toBe('v1');
    expect(payload.color).toBe('yellow');
    expect(payload.endOffset).toBeGreaterThan(payload.startOffset);
    // The second comes from the block, never from a picker.
    expect(payload.startSeconds).toBe(538);
  });
});

describe('App — the way back from a branch lets the mark glow', () => {
  it('finds the mark that opened this chat and shows it in the pane', async () => {
    // Nutzer-Report 2026-08-16: „wenn ich vom Chat zum markierten Text
    // zurückgehe, glüht es nicht auf". Der PDF-Weg war verdrahtet, der
    // Video-Weg nicht — der Zweig fand seine Markierung nicht.
    const branch: Chat = {
      id: 'c2', title: 'Über Features', parent_id: 'c1',
      parent_word: 'a kind of zip file of the internet',
      created_at: '2026-08-16T00:00:10Z', children: [],
    };
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branch] }]);
    vi.mocked(api.listTranscriptHighlights).mockResolvedValue([
      {
        id: 'th5', videoId: 'v1', color: 'yellow', text: 'a kind of zip file of the internet',
        startOffset: 30, endOffset: 64, startSeconds: 538, childChatId: 'c2',
        source: 'transcript',
        createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
      },
    ]);
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2'
        ? { ...branch, messages: [], children: [] }
        : { ...rootDetail, children: [branch] },
    );

    await openVideoChat();
    fireEvent.click(await screen.findByText('Über Features'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));

    // Zurück über die Branch-Kopfzeile.
    const backLink = (await screen.findByTestId('branched-from-quote')).querySelector('[role="link"]')!;
    fireEvent.click(backLink);

    await waitFor(() => {
      const marks = document.querySelectorAll('[data-testid="transcript-highlight"]');
      const flashing = document.querySelectorAll('[data-flash="true"]');
      const view = document.querySelector('[data-testid="video-transcript"]') ? 'transcript' : 'chapters';
      expect({ marks: marks.length, flashing: flashing.length, view })
        .toEqual({ marks: 1, flashing: 1, view: 'transcript' });
    });
  });
});
