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

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App, { AUTO_CONTINUE_MAX, AUTO_CONTINUE_CEILING, AUTO_CONTINUE_ERROR_RETRIES, autoContinueMaxRounds } from '../App';
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
  // 14:20 — the OVERVIEW fixture below runs to 14:14, so the base tree is a
  // COMPLETE overview. With a longer video every one of these fixtures would
  // read as "stopped early" and the automat would fire in tests about
  // something else entirely.
  duration_seconds: 860,
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

const CUT = '## An LLM is two files [0:00 - 7:30]\n\n**A model.**\n\n- **parameters.bin**: 140 GB, und dann';

/** A tree whose overview stopped mid-sentence. */
function openCutOverview() {
  vi.mocked(api.getChat).mockResolvedValue({
    ...rootDetail,
    messages: [messages[0], { ...messages[1], content: CUT, truncated: 1 }],
  });
  return openVideoChat();
}

// ─── Der Runaway-Schutz wächst mit dem Video ────────────────────────────────
// Nutzerentscheidung 2026-09-04: ein Modell, das pro Minute gedrosselt wird,
// sieht nur wenige Videominuten je Runde — bei einem 3:42:37-Vortrag reichten
// die festen zwanzig Runden bis 27:05 und nicht weiter. Wer nur EIN solches
// Modell hat, dem hilft kein größeres Budget, nur mehr Runden.

describe('autoContinueMaxRounds', () => {
  it('leaves short videos at the flat twenty', () => {
    expect(autoContinueMaxRounds(860)).toBe(AUTO_CONTINUE_MAX);      // 14:20
    expect(autoContinueMaxRounds(3991)).toBe(AUTO_CONTINUE_MAX);     // 1:06:31
  });

  it('grows for a video the flat twenty could not finish', () => {
    // 3:42:37 — the user's talk. At the measured ~8 minutes a metered round
    // covers, twenty rounds reach a quarter of it.
    expect(autoContinueMaxRounds(13357)).toBeGreaterThan(AUTO_CONTINUE_MAX);
    expect(autoContinueMaxRounds(13357)).toBe(42);
  });

  it('stays a guard: never past the ceiling, never undefined', () => {
    expect(autoContinueMaxRounds(60 * 60 * 24)).toBe(AUTO_CONTINUE_CEILING);
    expect(autoContinueMaxRounds(null)).toBe(AUTO_CONTINUE_MAX);
    expect(autoContinueMaxRounds(undefined)).toBe(AUTO_CONTINUE_MAX);
    expect(autoContinueMaxRounds(0)).toBe(AUTO_CONTINUE_MAX);
  });
});

describe('App — chapter list mirrors the state of the overview', () => {
  it('keeps quiet when the overview is complete', async () => {
    await openVideoChat();
    await screen.findByTestId('video-chapters');
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });
});

// ─── §01 Variante A: die App schreibt still weiter ──────────────────────────
// design/mockup-video-overview-progress.html §01, Nutzerentscheidung
// 2026-08-18. Ein Klick, der immer dieselbe Antwort ist, ist keine
// Entscheidung — die App hängt selbst an. Die Karte bleibt für die Fälle, in
// denen der Automat aufgibt.

describe('App — a cut-off overview continues by itself', () => {
  it('appends without a click and shows no card', async () => {
    vi.mocked(api.continueMessage).mockResolvedValue({
      userMessage: messages[0],
      assistantMessage: { ...messages[1], content: OVERVIEW, truncated: 0 },
    });

    await openCutOverview();

    await waitFor(() =>
      expect(api.continueMessage).toHaveBeenCalledWith('c1', 'm2', expect.any(Function), expect.anything()),
    );
    expect(api.continueMessage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByTestId('video-chapter')).toHaveLength(2));
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });

  it('keeps going round after round until the answer is whole', async () => {
    // The provider that made this necessary cuts EVERY round short — measured
    // on gemini-flash-latest, which ended one round after 68 tokens
    // (2026-08-18). So the number of rounds is not the point; finishing is.
    let round = 0;
    let grown = CUT;
    vi.mocked(api.continueMessage).mockImplementation(async () => {
      round += 1;
      grown += ' und weiter';
      const done = round === 6;
      return {
        userMessage: messages[0],
        assistantMessage: { ...messages[1], content: done ? OVERVIEW : grown, truncated: done ? 0 : 1 },
      };
    });

    await openCutOverview();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(screen.getAllByTestId('video-chapter')).toHaveLength(2));
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });

  it('stops at the runaway ceiling and hands the decision back', async () => {
    // A provider that never finishes must not spend calls forever: every round
    // carries the whole transcript again (~17k prompt tokens, measured).
    let grown = CUT;
    vi.mocked(api.continueMessage).mockImplementation(async () => {
      grown += ' und weiter';
      return { userMessage: messages[0], assistantMessage: { ...messages[1], content: grown, truncated: 1 } };
    });

    await openCutOverview();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalledTimes(AUTO_CONTINUE_MAX));
    expect(await screen.findByTestId('video-chapters-truncated')).toBeInTheDocument();
    // The manual exit still works — and does not restart the automat.
    fireEvent.click(screen.getByTestId('video-continue-button'));
    await waitFor(() => expect(api.continueMessage).toHaveBeenCalledTimes(AUTO_CONTINUE_MAX + 1));
  });

  it('gives up as soon as a round appends nothing', async () => {
    // A round that adds no text would repeat forever — four identical calls
    // for nothing. One is enough to know.
    vi.mocked(api.continueMessage).mockResolvedValue({
      userMessage: messages[0],
      assistantMessage: { ...messages[1], content: CUT, truncated: 1 },
    });

    await openCutOverview();

    expect(await screen.findByTestId('video-chapters-truncated')).toBeInTheDocument();
    expect(api.continueMessage).toHaveBeenCalledTimes(1);
  });

  it('recovers when a retry succeeds after transient errors', async () => {
    // The exact shape of the 2026-08-30 incident: the ladder's first two
    // candidates fail in quick succession, the third goes through.
    let attempt = 0;
    vi.mocked(api.continueMessage).mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('offline');
      return { userMessage: messages[0], assistantMessage: { ...messages[1], content: OVERVIEW, truncated: 0 } };
    });

    await openCutOverview();

    await waitFor(() => expect(screen.getAllByTestId('video-chapter')).toHaveLength(2));
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
    expect(api.continueMessage).toHaveBeenCalledTimes(3);
  });

  it('continues even before the first time mark exists', async () => {
    // The case from the user's screenshot (2026-08-18): the answer broke off
    // after its very first heading, which carries no [0:00 - …] mark yet. No
    // chapter parses, so the pane knows no "overview" — and the automat, hung
    // on that overview, never ran. The tree's root chat is the anchor instead.
    const noMarkYet = 'Hier ist die vollständige, chronologische Gliederung:\n\n### Einleitung und Bestandteile eines Large Language Models';
    vi.mocked(api.getChat).mockResolvedValue({
      ...rootDetail,
      messages: [messages[0], { ...messages[1], content: noMarkYet, truncated: 1 }],
    });
    vi.mocked(api.continueMessage).mockResolvedValue({
      userMessage: messages[0],
      assistantMessage: { ...messages[1], content: OVERVIEW, truncated: 0 },
    });

    await openVideoChat();

    await waitFor(() =>
      expect(api.continueMessage).toHaveBeenCalledWith('c1', 'm2', expect.any(Function), expect.anything()),
    );
    expect(api.continueMessage).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByTestId('video-chapter')).toHaveLength(2));
  });

  it('continues an overview that calls itself finished after a quarter of the video', async () => {
    // The Flash Lite case (user report 2026-08-18): `finish=stop`, nothing
    // truncated, and 16:16 of a 1:06:31 video covered. No flag says anything
    // is missing — the overview's own time ranges do.
    const short = '## Einführung [00:00 - 03:34]\n\n**Kernaussage.**\n\n## Refaktorierung [12:56 - 16:16]\n\n**Kernaussage.**';
    vi.mocked(api.getTreeVideo).mockResolvedValue({ ...video, duration_seconds: 3991 });
    vi.mocked(api.getChat).mockResolvedValue({
      ...rootDetail,
      messages: [messages[0], { ...messages[1], content: short, truncated: 0 }],
    });
    vi.mocked(api.continueMessage).mockResolvedValue({
      userMessage: messages[0],
      assistantMessage: { ...messages[1], content: `${short}\n\n## Schluss [16:16 - 1:06:20]\n\n**Kernaussage.**`, truncated: 0 },
    });

    await openVideoChat();

    await waitFor(() =>
      expect(api.continueMessage).toHaveBeenCalledWith('c1', 'm2', expect.any(Function), expect.anything()),
    );
    await waitFor(() => expect(screen.getAllByTestId('video-chapter')).toHaveLength(3));
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });

  it('says the overview STOPS, not that it broke off, when nothing was cut', async () => {
    // Two different events, two different sentences: a cut answer broke off,
    // a short one simply ends. Claiming a break where there was none is a lie
    // about what the provider did.
    const short = '## Einführung [00:00 - 03:34]\n\n**Kernaussage.**\n\n## Refaktorierung [12:56 - 16:16]\n\n**Kernaussage.**';
    vi.mocked(api.getTreeVideo).mockResolvedValue({ ...video, duration_seconds: 3991 });
    vi.mocked(api.getChat).mockResolvedValue({
      ...rootDetail,
      messages: [messages[0], { ...messages[1], content: short, truncated: 0 }],
    });
    // Every round writes nothing — the automat gives up after the first.
    vi.mocked(api.continueMessage).mockResolvedValue({
      userMessage: messages[0],
      assistantMessage: { ...messages[1], content: short, truncated: 0 },
    });

    await openVideoChat();

    const card = await screen.findByTestId('video-chapters-truncated');
    expect(card).toHaveTextContent('16:16');
    expect(card.textContent).not.toContain('brach');
  });

  it('retries an errored round in place before putting the card back', async () => {
    // A round that errors outright is often the ladder's candidates being
    // briefly unavailable together (user incident 2026-08-30: Groq quota
    // then a second model failing within 0.2s) — worth a few automatic
    // retries before handing the reader the fallback card.
    vi.mocked(api.continueMessage).mockRejectedValue(new Error('offline'));

    await openCutOverview();

    expect(await screen.findByTestId('video-chapters-truncated')).toBeInTheDocument();
    expect(api.continueMessage).toHaveBeenCalledTimes(AUTO_CONTINUE_ERROR_RETRIES);
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

  it('switches to the parent chat when the source is a chat passage', async () => {
    // User report 2026-08-19: in a video tree the "Branched from" link did
    // nothing at all. The branch had been opened from a passage in the
    // parent's ANSWER, not from the transcript — so the way back aimed at the
    // parent context pane, which a video tree never renders (the center
    // column belongs to the video). The click set an invisible scroll target
    // and returned: no jump, no glow, no chat switch.
    const branch: Chat = {
      id: 'c2', title: 'Wie funktionieren Aktivierungen?', parent_id: 'c1',
      parent_word: 'Pre-training compresses the internet',
      created_at: '2026-08-19T00:00:10Z', children: [],
    };
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branch] }]);
    // No transcript mark — the passage lives in a message of the parent chat.
    vi.mocked(api.listTranscriptHighlights).mockResolvedValue([]);
    vi.mocked(api.listMessageHighlights).mockImplementation(async (id: string) =>
      id === 'c1'
        ? [{
            id: 'mh7', messageId: 'm2', chatId: 'c1', childChatId: 'c2',
            startOffset: OVERVIEW.indexOf('Pre-training compresses the internet'),
            endOffset: OVERVIEW.indexOf('Pre-training compresses the internet') + 36,
            text: 'Pre-training compresses the internet', color: 'yellow',
            createdAt: '2026-08-19T00:00:00Z', updatedAt: '2026-08-19T00:00:00Z',
          }]
        : [],
    );
    vi.mocked(api.getChat).mockImplementation(async (id: string) =>
      id === 'c2'
        ? { ...branch, messages: [], children: [] }
        : { ...rootDetail, children: [branch] },
    );

    const original = window.HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      await openVideoChat();
      fireEvent.click(await screen.findByText('Wie funktionieren Aktivierungen?'));
      await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));

      const backLink = (await screen.findByTestId('branched-from-quote')).querySelector('[role="link"]')!;
      fireEvent.click(backLink);

      // The parent chat takes over the right column — its header is a title
      // again, not a "Branched from" quote — and the source message scrolls
      // into view.
      await waitFor(() => expect(screen.queryByTestId('branched-from-quote')).not.toBeInTheDocument());
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      const target = scrollIntoView.mock.instances.at(-1) as HTMLElement;
      expect(screen.getByTestId('message-row-m2').contains(target)).toBe(true);
    } finally {
      window.HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it('keeps the chapters standing while the parent chat is still loading', async () => {
    // User report 2026-08-19: on the way back "Noch keine Kapitel" flashes in
    // the center column for about a second. activeChatId switches at once,
    // but the chat DETAIL only arrives a round trip later — in that gap the
    // chapter source was decided from the chat that was still on screen (the
    // branch, which has no overview) and the list emptied itself.
    const branch: Chat = {
      id: 'c2', title: 'Wie funktionieren Aktivierungen?', parent_id: 'c1',
      parent_word: 'Pre-training compresses the internet',
      created_at: '2026-08-19T00:00:10Z', children: [],
    };
    vi.mocked(api.getTree).mockResolvedValue([{ ...rootChat, children: [branch] }]);
    vi.mocked(api.listTranscriptHighlights).mockResolvedValue([]);

    // The parent's load is held open from the moment the way back is clicked,
    // so the gap the user sees becomes a state the test can look at.
    let releaseParent: (() => void) | null = null;
    vi.mocked(api.getChat).mockImplementation(async (id: string) => {
      if (id === 'c2') return { ...branch, messages: [], children: [] };
      if (releaseParent === null) return { ...rootDetail, children: [branch] };
      await new Promise<void>((resolve) => { releaseParent = resolve; });
      return { ...rootDetail, children: [branch] };
    });

    await openVideoChat();
    await screen.findByTestId('video-chapters');
    fireEvent.click(await screen.findByText('Wie funktionieren Aktivierungen?'));
    await waitFor(() => expect(api.getChat).toHaveBeenCalledWith('c2'));
    await screen.findByTestId('video-chapters');

    releaseParent = () => {};
    const backLink = (await screen.findByTestId('branched-from-quote')).querySelector('[role="link"]')!;
    fireEvent.click(backLink);

    // The gap itself: watch it for as long as the parent chat stays out —
    // the empty card must not appear for a single frame of it.
    let sawEmpty = false;
    for (let i = 0; i < 20 && !sawEmpty; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
      if (screen.queryByTestId('video-chapters-empty')) sawEmpty = true;
    }
    // Proof that we really watched the gap: the branch is still on screen,
    // because its replacement has not arrived yet.
    expect(screen.getByTestId('branched-from-quote')).toBeInTheDocument();
    expect(sawEmpty).toBe(false);
    expect(screen.getAllByTestId('video-chapter')).toHaveLength(2);

    releaseParent!();
    await waitFor(() => expect(screen.queryByTestId('branched-from-quote')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('video-chapter')).toHaveLength(2);
  });
});

// ─── Die Videospalte ist eine Tastatur-Region ───────────────────────────────
// ADR-0011: die Mittelspalte ist die Quelle, ob dort ein PDF oder ein Video
// steht. Ohne diese Verdrahtung sprang der Ring von der Seitenleiste direkt in
// den Chat und die ganze Videospalte war ohne Maus unerreichbar
// (Nutzer-Report 2026-08-17).

describe('App — keyboard navigation reaches the video column', () => {
  it('walks the ring from the sidebar into the video pane', async () => {
    await openVideoChat();
    await screen.findByTestId('video-chapters');

    // Das erste Escape landet dort, wo die App den Nutzer schon verortet: auf
    // der blauen Pille des offenen Chats in der Seitenleiste.
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    await waitFor(() =>
      expect(screen.getByTestId('video-pane').querySelector('[data-focus-ring]')).not.toBeNull(),
    );
  });

  it('jumps the player when ↵ presses a chapter', async () => {
    await openVideoChat();
    await screen.findByTestId('video-chapters');

    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    // Ein Sprung setzt einen Player voraus, der schon gelaufen ist.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.youtube.com',
        data: JSON.stringify({ event: 'infoDelivery', info: { playerState: 1, currentTime: 3 } }),
      }),
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    // Umschalter, Transkript-Knopf, erstes Kapitel, zweites Kapitel.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });

    // Zweite Überschrift: [8:58 - 14:14] → 538 s, minus zwei Sekunden Vorlauf.
    await waitFor(() => {
      const sent = post.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(sent).toContainEqual({ event: 'command', func: 'seekTo', args: [536, true] });
    });
  });

  it('switches to the transcript when ↵ presses the view switch', async () => {
    await openVideoChat();
    await screen.findByTestId('video-chapters');

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(await screen.findByTestId('video-transcript')).toBeInTheDocument();
  });
});

// ─── Eine laufende Runde ist sichtbar, und die Karte schweigt solange ──────
// Nutzer-Report 2026-08-18: „das taucht jedes Mal auf, während du versuchst"
// — die Karte „Weiterschreiben" blitzte zwischen zwei automatischen Runden
// auf, und im Chat sah die Antwort fertig aus, während im Hintergrund noch
// geschrieben wurde.

describe('App — while a round is running', () => {
  const CUT_SHORT = '## Einführung [00:00 - 03:34]\n\n**Kernaussage.**';

  beforeEach(() => {
    vi.mocked(api.getTreeVideo).mockResolvedValue({ ...video, duration_seconds: 3991 });
    vi.mocked(api.getChat).mockResolvedValue({
      ...rootDetail,
      messages: [messages[0], { ...messages[1], content: CUT_SHORT, truncated: 1 }],
    });
  });

  it('hides the card and shows that the overview is being written', async () => {
    // Die Runde hängt — genau der Zustand, in dem der Nutzer die Karte sah.
    vi.mocked(api.continueMessage).mockImplementation(() => new Promise(() => {}));

    await openVideoChat();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('video-chapters-writing')).toBeInTheDocument());
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });

  it('marks the chat as still answering, so the bubble does not look finished', async () => {
    vi.mocked(api.continueMessage).mockImplementation(() => new Promise(() => {}));

    await openVideoChat();

    await waitFor(() => expect(api.continueMessage).toHaveBeenCalled());
    // Derselbe Zustand wie bei einer normalen Antwort im Fluss: der Composer
    // ist gesperrt, solange dieser Chat beschrieben wird.
    await waitFor(() => expect(screen.getByTestId('stop-button')).toBeInTheDocument());
  });
});

/**
 * Der Zustand, den der Nutzer fotografierte (2026-08-18): Die Antwort läuft
 * noch, die Kapitelliste wächst — und mittendrin bot die Karte an, genau diese
 * Antwort „weiterzuschreiben". Solange dieser Chat antwortet, schweigt sie.
 */
describe('App — the card while the FIRST answer is still streaming', () => {
  it('stays quiet and lets the pane say "writing" instead', async () => {
    const partial = '## Einführung [00:00 - 03:34]\n\n**Kernaussage.**';
    vi.mocked(api.getTreeVideo).mockResolvedValue({ ...video, duration_seconds: 3991 });
    vi.mocked(api.getChat).mockResolvedValue({
      ...rootDetail,
      messages: [messages[0], { ...messages[1], content: partial, truncated: 0 }],
    });
    // Die Antwort ist noch im Fluss — der Strom endet in diesem Test nie.
    vi.mocked(api.sendMessageStream).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.continueMessage).mockImplementation(() => new Promise(() => {}));

    await openVideoChat();
    // Eine Frage stellen: ab jetzt gilt der Chat als antwortend.
    const box = screen.getByTestId('chat-textarea');
    fireEvent.change(box, { target: { value: 'Und weiter?' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('video-chapters-writing')).toBeInTheDocument());
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
  });
});
