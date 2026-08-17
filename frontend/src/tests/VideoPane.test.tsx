/**
 * VideoPane.test.tsx
 *
 * The video pane in the middle column — the video counterpart of PdfView
 * (design/mockup-youtube-embed-layout.html, variant C chosen by the user
 * 2026-08-15): the video plays embedded, and under it stand the chapters of
 * the Video overview. The toolbar switches between Chapters (the default) and
 * the raw Transcript.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { VideoPane } from '../components/VideoPane';
import type { Video } from '../types';

const video: Video = {
  id: 'v1',
  youtube_id: 'zjkBMFhNj_g',
  title: 'Intro to Large Language Models',
  channel: 'Andrej Karpathy',
  duration_seconds: 3587,
  language: 'en',
  url: 'https://www.youtube.com/watch?v=zjkBMFhNj_g',
  transcript: '[00:00] Hi everyone.\n\n[07:30] So this is the pre-training stage.',
};

const overview = `## An LLM is two files [0:00 - 7:30]

**A model you can hold in your hand.**

- **parameters.bin**: 140 GB.

## Where the parameters come from [7:30 - 14:14]

**Pre-training compresses the internet.**

- **Cost**: ~$2 M.
`;

// Der Player meldet seinen Zustand über denselben Kanal wie die Spielzeit.
// Viele Tests prüfen das SPRINGEN — das setzt einen Player voraus, der schon
// gelaufen ist: solange er nie gespielt hat, bekommt er die Stelle bewusst
// über seine `start`-Sekunde statt über einen Sprung (Nutzerwunsch
// 2026-08-16, „das Video soll der Nutzer starten").
function reportPlayerState(playerState: number, currentTime = 0) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: 'https://www.youtube.com',
      data: JSON.stringify({ event: 'infoDelivery', info: { playerState, currentTime } }),
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VideoPane', () => {
  it('meldet sich beim Player über den widget-Kanal an, sonst kommen keine Zeiten', () => {
    vi.useFakeTimers();
    render(<VideoPane video={video} overview={overview} />);
    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    // In der echten App ist das iframe-load-Ereignis oft schon vorbei, bevor
    // der Effekt hängt — deshalb wird der Handschlag wiederholt, bis der
    // Player antwortet (im Browser gemessen 2026-08-15: ohne
    // channel:'widget' kommt NIE ein infoDelivery).
    act(() => {
      vi.advanceTimersByTime(1200);
    });

    const sent = post.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(sent).toContainEqual({ event: 'listening', id: 1, channel: 'widget' });

    // Sobald der Player Zeiten schickt, hört das Klopfen auf.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12 } }),
        }),
      );
    });
    const before = post.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(post.mock.calls.length).toBe(before);
  });

  it('zieht die Kapitelmarke mit der Spielzeit mit, ohne dass man klickt', () => {
    render(<VideoPane video={video} overview={overview} />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 460 } }),
        }),
      );
    });

    // 460 s liegt im zweiten Abschnitt ([7:30 - 14:14]) — die Marke wandert
    // dorthin, auch wenn der letzte Klick auf dem ersten Kapitel lag.
    expect(screen.getAllByTestId('video-chapter')[1]).toHaveAttribute('aria-current', 'true');
  });

  it('bettet das Video ein und zeigt die Kapitel als Standardansicht', () => {
    render(<VideoPane video={video} overview={overview} />);

    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    expect(frame.src).toContain('/embed/zjkBMFhNj_g');
    // enablejsapi: ohne das Flag nimmt der Player keine seekTo-Befehle an.
    expect(frame.src).toContain('enablejsapi=1');

    expect(screen.getByTestId('video-chapters')).toBeInTheDocument();
    expect(screen.getByText('An LLM is two files')).toBeInTheDocument();
    expect(screen.getByText('Where the parameters come from')).toBeInTheDocument();
    expect(screen.getByText('Pre-training compresses the internet.')).toBeInTheDocument();
    // Die Chips sehen aus wie die Marken im Transkript: zweistellige Minuten.
    expect(screen.getByText('07:30')).toBeInTheDocument();

    // Das Rohtranskript liegt in dieser Ansicht nicht offen.
    expect(screen.queryByTestId('video-transcript')).not.toBeInTheDocument();
  });

  it('schaltet zwischen Kapiteln und Transkript um — Kapitel bleiben der Default', () => {
    render(<VideoPane video={video} overview={overview} />);

    expect(screen.getByTestId('video-view-chapters')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('video-view-transcript'));

    expect(screen.getByTestId('video-transcript')).toBeInTheDocument();
    expect(screen.getByText('So this is the pre-training stage.')).toBeInTheDocument();
    expect(screen.queryByTestId('video-chapters')).not.toBeInTheDocument();
    expect(screen.getByTestId('video-view-transcript')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('video-view-chapters'));

    expect(screen.getByTestId('video-chapters')).toBeInTheDocument();
    expect(screen.queryByTestId('video-transcript')).not.toBeInTheDocument();
  });

  it('springt im eingebetteten Player, wenn man ein Kapitel anklickt', () => {
    render(<VideoPane video={video} overview={overview} />);
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen
    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    const sent = post.mock.calls.map((c) => JSON.parse(String(c[0])));
    // 7:30 = 450 s, minus zwei Sekunden Vorlauf: die Marken sind grobe
    // 30-Sekunden-Absätze, ein Sprung landet sonst mitten im Satz.
    expect(sent).toContainEqual({ event: 'command', func: 'seekTo', args: [448, true] });
  });

  it('markiert das laufende Kapitel, wenn der Player seine Zeit meldet', () => {
    render(<VideoPane video={video} overview={overview} />);

    expect(screen.getAllByTestId('video-chapter')[0]).toHaveAttribute('aria-current', 'true');

    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'https://www.youtube.com',
        data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 900 } }),
      }),
    );

    expect(screen.getAllByTestId('video-chapter')[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.getAllByTestId('video-chapter')[0]).not.toHaveAttribute('aria-current');
  });

  it('markiert die angeklickte Zeile, nicht den Unterpunkt mit derselben Startzeit', () => {
    const mitUnterpunkten = `## 3. Die Zukunft der Datenverarbeitung [7:48 - 13:30]

**Der Rechner wird umgebaut.**

### Die Architektur der Zukunft [7:48 - 9:40]

**Das Netz wird der Hauptprozess.**
`;
    render(<VideoPane video={video} overview={mitUnterpunkten} />);
    const rows = screen.getAllByTestId('video-chapter');

    fireEvent.click(rows[0]);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');

    // Der Player meldet eine Zeit im Bereich BEIDER Zeilen — die angeklickte
    // behält die Marke, bis das Video ihren Abschnitt verlässt.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 500 } }),
        }),
      );
    });
    expect(screen.getAllByTestId('video-chapter')[0]).toHaveAttribute('aria-current', 'true');

    // Hinter 13:30 endet der angeklickte Abschnitt: die Marke folgt wieder der
    // Spielzeit (hier der letzte Abschnitt, der begonnen hat).
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 900 } }),
        }),
      );
    });
    expect(screen.getAllByTestId('video-chapter')[1]).toHaveAttribute('aria-current', 'true');
  });

  it('erklärt den leeren Zustand, solange es keine Übersicht gibt', () => {
    render(<VideoPane video={video} overview={null} />);

    expect(screen.getByTestId('video-chapters-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('video-chapter')).not.toBeInTheDocument();
    // Der Player steht trotzdem da, und das Transkript ist einen Klick weit weg.
    expect(screen.getByTestId('video-player-frame')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('video-view-transcript'));
    expect(screen.getByText('Hi everyone.')).toBeInTheDocument();
  });

  it('zeigt eine ruhige Karte statt eines Fehlers, wenn der Kanal das Einbetten verbietet', () => {
    render(<VideoPane video={video} overview={overview} />);

    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'https://www.youtube.com',
        data: JSON.stringify({ event: 'onError', info: 101 }),
      }),
    );

    expect(screen.getByTestId('video-embed-blocked')).toBeInTheDocument();
    expect(screen.queryByTestId('video-player-frame')).not.toBeInTheDocument();
    // Die Quelle funktioniert weiter: Kapitel bleiben stehen.
    expect(screen.getAllByTestId('video-chapter')).toHaveLength(2);
  });

  it('holt das Transkript nach, wenn die Transkriptansicht es braucht', () => {
    const onRequestTranscript = vi.fn();
    // Direkt nach dem Import liegt nur die Import-Antwort im State — ohne Text.
    const ohneText: Video = { ...video, transcript: undefined };
    render(
      <VideoPane video={ohneText} overview={overview} onRequestTranscript={onRequestTranscript} />,
    );

    // Solange die Kapitel oben liegen, wird nichts geholt.
    expect(onRequestTranscript).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('video-view-transcript'));
    expect(onRequestTranscript).toHaveBeenCalledTimes(1);
  });

  it('fragt nicht nach, wenn das Transkript schon da ist', () => {
    const onRequestTranscript = vi.fn();
    render(<VideoPane video={video} overview={overview} onRequestTranscript={onRequestTranscript} />);

    fireEvent.click(screen.getByTestId('video-view-transcript'));
    expect(onRequestTranscript).not.toHaveBeenCalled();
  });

  it('ignoriert Nachrichten, die nicht vom Player kommen', () => {
    render(<VideoPane video={video} overview={overview} />);

    fireEvent(
      window,
      new MessageEvent('message', {
        origin: 'https://evil.example',
        data: JSON.stringify({ event: 'onError', info: 150 }),
      }),
    );

    expect(screen.queryByTestId('video-embed-blocked')).not.toBeInTheDocument();
  });
});

describe('VideoPane · Unterabschnitte', () => {
  it('weist Unterabschnitte als solche aus, statt sie wie Hauptabschnitte zu zeigen', () => {
    const mitUnterpunkten = `## 3. Die Zukunft der Datenverarbeitung [7:48 - 13:30]

**Der Rechner wird umgebaut.**

### Die Architektur der Zukunft [7:48 - 9:40]

**Das Netz wird der Hauptprozess.**
`;
    render(<VideoPane video={video} overview={mitUnterpunkten} />);
    const rows = screen.getAllByTestId('video-chapter');

    expect(rows[0]).toHaveAttribute('data-level', '2');
    expect(rows[1]).toHaveAttribute('data-level', '3');
    expect(rows[1].style.marginLeft).not.toBe('');
  });
});

describe('VideoPane · Marke folgt bis zur nächsten Marke', () => {
  // Im echten Chat gemessen (2026-08-15): Klick auf „13:30 · 4. Vibe Coding…",
  // Player bei 16:01 — die Marke blieb auf 13:30 stehen, obwohl der Unterpunkt
  // „15:45 · Begriffsunterscheidung" längst lief.
  const langerAbschnitt = `## 4. Vibe Coding vs. Agentic Engineering [13:30 - 22:15]

**Zwei Begriffe, zwei Arbeitsweisen.**

### Begriffsunterscheidung [15:45 - 18:09]

**Der Unterschied liegt in der Verantwortung.**
`;

  it('gibt die angeklickte Zeile frei, sobald die nächste Marke erreicht ist', () => {
    render(<VideoPane video={video} overview={langerAbschnitt} />);
    const rows = screen.getAllByTestId('video-chapter');
    fireEvent.click(rows[0]);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 961 } }),
        }),
      );
    });

    expect(screen.getAllByTestId('video-chapter')[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.getAllByTestId('video-chapter')[0]).not.toHaveAttribute('aria-current');
  });
});

describe('VideoPane · Sprung ohne Rückzucken', () => {
  // Nutzer-Report mit Bild (2026-08-15): „als ich ein neues Kapitel anklicke,
  // springt es zum früheren und dann zu dem, was ich geklickt habe."
  // Ursache: der Player meldet nach einem seekTo noch einige Male die ALTE
  // Position. Diese verspäteten Meldungen dürfen die Marke nicht zurückziehen.
  const zweiKapitel = `## Universalität [4:46 - 9:22]

**Netze bilden dieselben Merkmale aus.**

## Bausteine: Neuronen, Features, Circuits [9:22 - 14:00]

**Features und Circuits sind die Einheiten.**
`;

  const meldeZeit = (currentTime: number) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime } }),
        }),
      );
    });

  it('ignoriert die alten Zeitmeldungen, bis der Sprung angekommen ist', () => {
    render(<VideoPane video={video} overview={zweiKapitel} />);
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen
    const rows = () => screen.getAllByTestId('video-chapter');

    // Video läuft im ersten Kapitel.
    meldeZeit(300);
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');

    // Klick auf das zweite Kapitel (9:22 = 562 s).
    fireEvent.click(rows()[1]);
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');

    // Der Player meldet noch dreimal die alte Stelle — die Marke bleibt.
    meldeZeit(300.4);
    meldeZeit(300.7);
    meldeZeit(301);
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');
    expect(rows()[0]).not.toHaveAttribute('aria-current');

    // Dann kommt der Sprung an.
    meldeZeit(561);
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');
  });

  it('nimmt die Wirklichkeit wieder an, wenn der Sprung nie ankommt', () => {
    render(<VideoPane video={video} overview={zweiKapitel} />);
    const rows = () => screen.getAllByTestId('video-chapter');

    fireEvent.click(rows()[1]);
    // Der Player bewegt sich nicht (Sprung verschluckt). Nach ein paar Sekunden
    // darf die Pane nicht weiter das Gegenteil behaupten.
    for (let i = 0; i < 20; i++) meldeZeit(300 + i * 0.25);

    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
  });

  it('folgt einem Rücksprung im Player selbst', () => {
    render(<VideoPane video={video} overview={zweiKapitel} />);
    const rows = () => screen.getAllByTestId('video-chapter');

    fireEvent.click(rows()[1]);
    meldeZeit(600);
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');

    // Der Nutzer zieht YouTubes eigene Leiste zurück ins erste Kapitel.
    meldeZeit(320);
    meldeZeit(321);
    expect(rows()[0]).toHaveAttribute('aria-current', 'true');
  });
});

describe('VideoPane · Liste folgt dem Video', () => {
  const zweiKapitel = `## Erstes Kapitel [0:00 - 5:00]

**Anfang.**

## Zweites Kapitel [5:00 - 9:00]

**Weiter.**
`;
  const langesTranskript = Array.from({ length: 12 }, (_, i) => {
    const m = String(Math.floor((i * 30) / 60)).padStart(2, '0');
    const s = String((i * 30) % 60).padStart(2, '0');
    return `[${m}:${s}] Absatz ${i}.`;
  }).join('\n\n');

  const meldeZeit = (currentTime: number) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime } }),
        }),
      );
    });

  it('scrollt das laufende Kapitel in den sichtbaren Bereich', () => {
    // Achtung: tests/setup.ts legt den Platzhalter auf HTMLElement.prototype —
    // ein Ersatz auf Element.prototype wird davon verdeckt und nie gerufen.
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

    render(<VideoPane video={video} overview={zweiKapitel} />);
    meldeZeit(320);

    const gescrollt = scrollSpy.mock.contexts.map(
      (el) => (el as HTMLElement).textContent?.slice(0, 14) ?? '',
    );
    expect(gescrollt.some((t) => t.includes('05:00'))).toBe(true);
    // Zentriert, nicht 'nearest': sonst klebt die Zeile am unteren Rand und ihr
    // Rahmen wird abgeschnitten (Nutzer-Report mit Bild 2026-08-16).
    // Zentriert UND gleitend (Nutzerwunsch 2026-08-16).
    expect(scrollSpy.mock.calls.at(-1)?.[0]).toMatchObject({ block: 'center', behavior: 'smooth' });
    scrollSpy.mockRestore();
  });

  it('markiert den laufenden Transkript-Absatz und scrollt ihn mit', () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

    render(<VideoPane video={{ ...video, transcript: langesTranskript }} overview={zweiKapitel} />);
    fireEvent.click(screen.getByTestId('video-view-transcript'));

    meldeZeit(310); // liegt im Absatz [05:00]
    const blocks = screen.getAllByTestId('video-transcript-block');
    const laufend = blocks.find((b) => b.getAttribute('aria-current') === 'true');

    expect(laufend?.textContent).toContain('05:00');
    const gescrollt = scrollSpy.mock.contexts.map(
      (el) => (el as HTMLElement).textContent?.slice(0, 14) ?? '',
    );
    expect(gescrollt.some((t) => t.includes('05:00'))).toBe(true);
    scrollSpy.mockRestore();
  });
});

describe('VideoPane · Bewegung reduzieren', () => {
  it('scrollt ohne Animation, wenn das System weniger Bewegung will', () => {
    const echt = window.matchMedia;
    // @ts-expect-error – Testdouble für die Medienabfrage
    window.matchMedia = (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} });
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');

    render(
      <VideoPane
        video={video}
        overview={'## Eins [0:00 - 5:00]\n\n**A.**\n\n## Zwei [5:00 - 9:00]\n\n**B.**\n'}
      />,
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 320 } }),
        }),
      );
    });

    expect(scrollSpy.mock.calls.at(-1)?.[0]).toMatchObject({ behavior: 'auto' });
    scrollSpy.mockRestore();
    window.matchMedia = echt;
  });
});

describe('VideoPane · verschluckter Sprung', () => {
  // Live beobachtet (2026-08-16): ein Klick unmittelbar nach dem Laden geht
  // verloren — der Player war noch nicht bereit, meldete weiter die alte Stelle,
  // und die Marke fiel nach ein paar Sekunden auf das erste Kapitel zurück.
  const zweiKapitel = `## Eins [0:00 - 5:00]

**A.**

## Zwei [5:00 - 9:00]

**B.**
`;

  it('schickt den Sprung erneut, solange der Player die alte Stelle meldet', () => {
    render(<VideoPane video={video} overview={zweiKapitel} />);
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen
    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    // Der Player rührt sich nicht.
    for (let i = 0; i < 9; i++) {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://www.youtube.com',
            data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: 30 + i * 0.25 } }),
          }),
        );
      });
    }

    const wiederholt = post.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .filter((m) => m.func === 'seekTo');
    expect(wiederholt.length).toBeGreaterThanOrEqual(1);
    expect(wiederholt[0]).toMatchObject({ func: 'seekTo', args: [298, true] });
  });
});

describe('VideoPane · kein doppelter Sprung', () => {
  // Nutzer-Report 2026-08-16: „wenn ich zu einem Kapitel springe, wiederholt
  // sich der Anfang zwei- oder dreimal, bevor das Video weiterläuft."
  // Ursache: der Sprung geht bewusst zwei Sekunden VOR die Marke. Wurde die
  // Ankunft gegen die Marke selbst geprüft, galt der Sprung in diesen zwei
  // Sekunden als verschluckt — und wurde erneut geschickt.
  const zweiKapitel = `## Eins [0:00 - 5:00]

**A.**

## Zwei [5:00 - 9:00]

**B.**
`;

  it('wiederholt nichts, wenn der Player am Sprungziel angekommen ist', () => {
    render(<VideoPane video={video} overview={zweiKapitel} />);
    const frame = screen.getByTestId('video-player-frame') as HTMLIFrameElement;
    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    // Der Player spielt ab 298 s (= 5:00 minus Vorlauf) — also angekommen,
    // obwohl die Kapitelmarke bei 300 s liegt.
    [298.2, 298.6, 299, 299.4, 299.8].forEach((t) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: 'https://www.youtube.com',
            data: JSON.stringify({ event: 'infoDelivery', info: { currentTime: t } }),
          }),
        );
      }),
    );

    const nochmal = post.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .filter((m) => m.func === 'seekTo');
    expect(nochmal).toHaveLength(0);
    // Und die Marke bleibt beim angeklickten Kapitel, auch in diesen zwei
    // Sekunden Vorlauf.
    expect(screen.getAllByTestId('video-chapter')[1]).toHaveAttribute('aria-current', 'true');
  });
});

describe('VideoPane · Vorlauf bleibt unsichtbar', () => {
  // Nutzer-Report 2026-08-16 (dritter Anlauf): „wenn ich zu einem Teil springe,
  // im Transkript oder in den Kapiteln, springt es zuerst zu dem früheren."
  // Ursache: der Sprung landet zwei Sekunden VOR der Marke. Diese zwei Sekunden
  // liegen im vorherigen Absatz/Kapitel — und genau die wurden angezeigt.
  const kapitel = `## Eins [0:00 - 5:00]

**A.**

## Zwei [5:00 - 9:00]

**B.**
`;
  const transkript = ['[04:00] vier', '[04:30] vierdreißig', '[05:00] fünf', '[05:30] fünfdreißig'].join('\n\n');

  const meldeZeit = (currentTime: number) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://www.youtube.com',
          data: JSON.stringify({ event: 'infoDelivery', info: { currentTime } }),
        }),
      );
    });

  it('bleibt beim angeklickten Transkript-Absatz, während der Vorlauf läuft', () => {
    render(<VideoPane video={{ ...video, transcript: transkript }} overview={kapitel} />);
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen
    fireEvent.click(screen.getByTestId('video-view-transcript'));

    const bloecke = () => screen.getAllByTestId('video-transcript-block');
    fireEvent.click(bloecke()[2]); // [05:00] → Sprung auf 298 s
    expect(bloecke()[2]).toHaveAttribute('aria-current', 'true');

    // Der Player ist am Sprungziel (298) angekommen und spielt den Vorlauf.
    meldeZeit(298.4);
    meldeZeit(299.2);
    expect(bloecke()[2]).toHaveAttribute('aria-current', 'true');
    expect(bloecke()[1]).not.toHaveAttribute('aria-current');

    // Ab der Marke selbst zählt wieder der Player.
    meldeZeit(300.5);
    expect(bloecke()[2]).toHaveAttribute('aria-current', 'true');
    meldeZeit(331);
    expect(bloecke()[3]).toHaveAttribute('aria-current', 'true');
  });

  it('gilt auch für einen Sprung aus dem Chat (kein Klick in der Liste)', () => {
    const griff = { current: null as { seekTo: (s: number) => void } | null };
    render(<VideoPane ref={griff} video={{ ...video, transcript: transkript }} overview={kapitel} />);
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen

    // Zeitmarke im Chat: [5:00] → seekTo(300) über den Griff.
    act(() => griff.current?.seekTo(300));
    meldeZeit(298.6);

    expect(screen.getAllByTestId('video-chapter')[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.getAllByTestId('video-chapter')[0]).not.toHaveAttribute('aria-current');
  });
});

// ─── Kapitelfenster: drei ehrliche Zustände ────────────────────────────────
// design/mockup-truncated-answer.html §02. Bis 2026-08-16 gab es nur EINEN
// Ersatztext — "Frag nach der Übersicht" — und der war falsch, seit die Frage
// beim Import automatisch rausgeht (structurePrompt). Die Pane wusste nichts
// vom laufenden Stream; sie bekam nur `overview`.

describe('VideoPane – Zustände der Kapitelliste', () => {
  it('sagt, dass die Übersicht gerade geschrieben wird, statt sie einzufordern', () => {
    render(<VideoPane video={video} overview={null} overviewStreaming />);
    expect(screen.getByTestId('video-chapters-writing')).toBeInTheDocument();
    // Der alte Ersatztext darf nicht mehr erscheinen — er verlangte eine
    // Frage, die längst automatisch gestellt wurde.
    expect(screen.queryByTestId('video-chapters-empty')).not.toBeInTheDocument();
  });

  it('zeigt die bisherigen Kapitel und sagt, wo die Übersicht abbrach', () => {
    const cut = `## An LLM is two files [0:00 - 7:30]\n\n**A model you can hold.**\n\n- **parameters.bin**: 140 GB, und dann`;
    render(
      <VideoPane video={video} overview={cut} overviewTruncated onContinueOverview={vi.fn()} />,
    );
    expect(screen.getAllByTestId('video-chapter')).toHaveLength(1);
    const note = screen.getByTestId('video-chapters-truncated');
    expect(note).toHaveTextContent('7:30');
  });

  it('bietet im abgebrochenen Zustand denselben Ausweg wie die Antwort selbst', () => {
    const onContinue = vi.fn();
    render(
      <VideoPane video={video} overview={overview} overviewTruncated onContinueOverview={onContinue} />,
    );
    fireEvent.click(screen.getByTestId('video-continue-button'));
    expect(onContinue).toHaveBeenCalled();
  });

  it('bleibt bei einer fertigen Übersicht unverändert', () => {
    render(<VideoPane video={video} overview={overview} />);
    expect(screen.getAllByTestId('video-chapter')).toHaveLength(2);
    expect(screen.queryByTestId('video-chapters-truncated')).not.toBeInTheDocument();
    expect(screen.queryByTestId('video-chapters-writing')).not.toBeInTheDocument();
  });
});

// ─── Markieren im Transcript ───────────────────────────────────────────────
// design/mockup-transcript-selection.html, Variante A (Nutzerwahl 2026-08-16):
// Ziehen markiert, ein einfacher Klick springt weiterhin. Das Transcript ist
// der echte Quelltext des Videos — die einzige Quelle in Syflo, aus der man
// bisher nicht zitieren oder verzweigen konnte.

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

describe('VideoPane – Auswahl im Transcript', () => {
  const openTranscript = (onTranscriptSelection = vi.fn()) => {
    const view = render(
      <VideoPane video={video} overview={overview} onTranscriptSelection={onTranscriptSelection} />,
    );
    fireEvent.click(screen.getByTestId('video-view-transcript'));
    return { view, onTranscriptSelection };
  };

  it('meldet die markierte Passage samt Sekunde ihres Blocks', () => {
    const { onTranscriptSelection } = openTranscript();
    const block = screen.getAllByTestId('video-transcript-block')[1];
    const textNode = block.querySelector('[data-transcript-text]')!.firstChild!;

    mockSelectionOver(textNode, 3, 15);
    fireEvent.mouseUp(block);

    expect(onTranscriptSelection).toHaveBeenCalledTimes(1);
    const arg = onTranscriptSelection.mock.calls[0][0];
    expect(arg.text.length).toBeGreaterThan(0);
    // 07:30 im zweiten Block — die Sekunde kommt aus dem Block, nicht aus
    // einer Auswahl des Nutzers (Nutzerentscheid 2026-08-16).
    expect(arg.seconds).toBe(450);
  });

  it('springt NICHT, wenn der Klick eine Markierung beendet', () => {
    const posted: unknown[] = [];
    const frame = { contentWindow: { postMessage: (m: unknown) => posted.push(m) } };
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
      frame.contentWindow as unknown as Window,
    );
    openTranscript();
    const block = screen.getAllByTestId('video-transcript-block')[1];
    const textNode = block.querySelector('[data-transcript-text]')!.firstChild!;
    mockSelectionOver(textNode, 3, 15);

    fireEvent.mouseUp(block);
    fireEvent.click(block);

    const seeks = posted.filter((m) => String(m).includes('seekTo'));
    expect(seeks).toHaveLength(0);
  });

  it('springt weiterhin bei einem einfachen Klick ohne Markierung', () => {
    const posted: unknown[] = [];
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
      { postMessage: (m: unknown) => posted.push(m) } as unknown as Window,
    );
    openTranscript();
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen
    const block = screen.getAllByTestId('video-transcript-block')[1];

    fireEvent.click(block);

    expect(posted.filter((m) => String(m).includes('seekTo')).length).toBeGreaterThan(0);
  });
});

// ─── Farbige Markierungen im Transcript ────────────────────────────────────
// Nutzerwunsch 2026-08-16: „es sollte möglich sein, sie mit Farben zu
// markieren". Anker sind Zeichen-Offsets ins Roh-Transcript — dieselbe Idee
// wie bei Chat-Markierungen, nur gegen das Video statt gegen eine Nachricht.

describe('VideoPane – gespeicherte Markierungen', () => {
  const transcript = '[00:00] Hi everyone.\n\n[07:30] A feature is the smallest unit.';
  const marked: Video = { ...video, transcript };

  it('malt die gespeicherte Passage in ihrer Farbe', () => {
    const start = transcript.indexOf('the smallest unit');
    render(
      <VideoPane
        video={marked}
        overview={overview}
        transcriptHighlights={[
          {
            id: 'th1', videoId: 'v1', color: 'green', text: 'the smallest unit',
            startOffset: start, endOffset: start + 'the smallest unit'.length,
            startSeconds: 450, childChatId: null,
            createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('video-view-transcript'));

    const mark = screen.getByTestId('transcript-highlight');
    expect(mark).toHaveTextContent('the smallest unit');
    expect(mark.getAttribute('data-color')).toBe('green');
  });

  it('lässt unmarkierten Text unangetastet', () => {
    render(<VideoPane video={marked} overview={overview} transcriptHighlights={[]} />);
    fireEvent.click(screen.getByTestId('video-view-transcript'));
    expect(screen.queryByTestId('transcript-highlight')).not.toBeInTheDocument();
    expect(screen.getByText(/A feature is the smallest unit/)).toBeInTheDocument();
  });
});

// ─── Markieren in den Kapiteln ─────────────────────────────────────────────
// Nutzerwunsch 2026-08-16: auch aus Kapiteln heraus markieren und verzweigen —
// aber NICHT über die Zeitstempel. Die Chips bleiben deshalb unmarkierbar,
// damit eine Auswahl nie "07:30" mit in die Frage schleppt.

describe('VideoPane – Auswahl in den Kapiteln', () => {
  it('meldet die markierte Passage mit der Sekunde ihres Kapitels', () => {
    const onChapterSelection = vi.fn();
    render(<VideoPane video={video} overview={overview} onChapterSelection={onChapterSelection} />);

    const chapter = screen.getAllByTestId('video-chapter')[1];
    // Der Titel des Kapitels — der erste echte Textknoten der Zeile.
    const node = chapter.querySelector('[data-chapter-text]')!.firstChild!.firstChild!;
    mockSelectionOver(node, 0, 10);
    fireEvent.mouseUp(chapter);

    expect(onChapterSelection).toHaveBeenCalledTimes(1);
    expect(onChapterSelection.mock.calls[0][0].seconds).toBe(450);
  });

  it('lässt die Zeitmarke aus jeder Auswahl heraus', () => {
    render(<VideoPane video={video} overview={overview} onChapterSelection={vi.fn()} />);
    const chip = screen.getAllByTestId('video-chapter')[0].querySelector('[data-chapter-mark]')!;
    // user-select: none — der Chip ist ein Sprungziel, kein Zitat.
    expect(chip.className).toMatch(/select-none/);
  });

  it('springt weiterhin, wenn nichts markiert ist', () => {
    const posted: unknown[] = [];
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
      { postMessage: (m: unknown) => posted.push(m) } as unknown as Window,
    );
    render(<VideoPane video={video} overview={overview} onChapterSelection={vi.fn()} />);
    act(() => reportPlayerState(1, 0)); // der Player läuft — sonst wird nicht gesprungen

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    expect(posted.filter((m) => String(m).includes('seekTo')).length).toBeGreaterThan(0);
  });
});

// ─── Parität mit normalem Text ─────────────────────────────────────────────
// Nutzerwünsche 2026-08-16, in Folge: Kapitel farbig markierbar; ein Klick auf
// eine Markierung führt in ihren Chat; der Rückweg lässt sie aufglühen; und
// ein Sprung startet ein pausiertes Video NICHT.

describe('VideoPane – Markierungen in den Kapiteln', () => {
  const chapterMark = (over = {}) => ({
    id: 'ch1', videoId: 'v1', color: 'pink' as const, text: 'An LLM is two files',
    startOffset: overview.indexOf('An LLM is two files'),
    endOffset: overview.indexOf('An LLM is two files') + 'An LLM is two files'.length,
    startSeconds: 0, childChatId: null, source: 'chapter' as const,
    createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
    ...over,
  });

  it('malt eine Kapitel-Markierung im Kapitel, nicht im Transcript', () => {
    render(<VideoPane video={video} overview={overview} transcriptHighlights={[chapterMark()]} />);

    const mark = screen.getByTestId('chapter-highlight');
    expect(mark).toHaveTextContent('An LLM is two files');
    expect(mark.getAttribute('data-color')).toBe('pink');
  });

  it('führt beim Klick auf eine verknüpfte Markierung in ihren Chat', () => {
    const onOpenHighlightChat = vi.fn();
    render(
      <VideoPane
        video={video}
        overview={overview}
        transcriptHighlights={[chapterMark({ childChatId: 'c9' })]}
        onOpenHighlightChat={onOpenHighlightChat}
      />,
    );

    fireEvent.click(screen.getByTestId('chapter-highlight'));

    expect(onOpenHighlightChat).toHaveBeenCalledWith('c9');
  });

  it('springt NICHT im Video, wenn die Markierung in den Chat führt', () => {
    const posted: unknown[] = [];
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
      { postMessage: (m: unknown) => posted.push(m) } as unknown as Window,
    );
    render(
      <VideoPane
        video={video}
        overview={overview}
        transcriptHighlights={[chapterMark({ childChatId: 'c9' })]}
        onOpenHighlightChat={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('chapter-highlight'));

    expect(posted.filter((m) => String(m).includes('seekTo'))).toHaveLength(0);
  });
});

describe('VideoPane – Sprung weckt kein pausiertes Video', () => {
  const withFrame = (posted: string[]) =>
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue(
      { postMessage: (m: unknown) => posted.push(String(m)) } as unknown as Window,
    );

  // Der Player meldet seinen Zustand über denselben Kanal wie die Spielzeit.
  const reportState = (playerState: number) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://www.youtube.com',
        data: JSON.stringify({ event: 'infoDelivery', info: { playerState, currentTime: 12 } }),
      }),
    );

  it('hält ein PAUSIERTES Video an, statt es beim Sprung zu starten', () => {
    const posted: string[] = [];
    withFrame(posted);
    render(<VideoPane video={video} overview={overview} />);
    act(() => { reportState(2); }); // 2 = pausiert

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    expect(posted.some((m) => m.includes('seekTo'))).toBe(true);
    expect(posted.some((m) => m.includes('pauseVideo'))).toBe(true);
  });

  it('hält ein nie gespieltes Video an, SOBALD es ein Bild hat — nicht früher', () => {
    // Nutzer-Report 2026-08-16, dritte Runde: mit `start=` in der URL zeigt
    // YouTube sein Kanal-Vorschaubild, nicht die Stelle. Ein Bild AN der
    // Stelle gibt es nur, wenn der Player sie wirklich erreicht — also
    // springen, das erste Bild abwarten (playerState 1 = spielt) und dann
    // anhalten. Ein pauseVideo davor macht schwarz.
    const posted: string[] = [];
    withFrame(posted);
    render(<VideoPane video={video} overview={overview} />);

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    // Der Sprung geht sofort raus, die Bremse noch nicht.
    expect(posted.some((m) => m.includes('seekTo'))).toBe(true);
    expect(posted.some((m) => m.includes('pauseVideo'))).toBe(false);

    // Der Player meldet, dass er spielt — jetzt hat er ein Bild.
    act(() => reportPlayerState(1, 450));

    expect(posted.some((m) => m.includes('pauseVideo'))).toBe(true);
  });

  it('bremst nur den EINEN Sprung, nicht jedes spätere Abspielen', () => {
    const posted: string[] = [];
    withFrame(posted);
    render(<VideoPane video={video} overview={overview} />);
    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);
    act(() => reportPlayerState(1, 450));
    const nachDemSprung = posted.length;

    // Der Nutzer drückt selbst auf Play: der Player meldet erneut "spielt".
    act(() => reportPlayerState(1, 455));

    expect(posted.length).toBe(nachDemSprung);
  });

  it('setzt keine start-Sekunde mehr in die Adresse', () => {
    // Nutzer-Report 2026-08-16: „wenn ich zum Chat mit dem Video gehe und auf
    // ein Kapitel klicke, startet das Video von selbst — das sollte der
    // Nutzer entscheiden." Die IFrame-API kennt für den Zustand „unstarted"
    // kein stilles Springen: seekTo spielt los, pauseVideo macht schwarz.
    // Also wird gar nicht gesprungen — der Player bekommt die Stelle über
    // seine `start`-Sekunde und bleibt stehen.
    const posted: string[] = [];
    withFrame(posted);
    render(<VideoPane video={video} overview={overview} />);

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    const frame = document.querySelector('iframe')!;
    // Die Adresse bleibt stabil — ein Reload würde das Vorschaubild
    // zurückholen, genau das, was der Nutzer nicht wollte.
    expect(frame.getAttribute('src')).not.toMatch(/[?&]start=/);
  });

  it('bremst einen nie gestarteten Player NICHT vor dem ersten Bild', () => {
    // Nutzer-Report 2026-08-16, drei Runden derselben Sache: „das Video ist
    // schwarz" (pauseVideo, bevor ein Bild da war), „das Video startet von
    // selbst" (kein Halt) und „es zeigt das Vorschaubild statt der Stelle"
    // (`&start=` in der URL). Der Halt kommt deshalb genau einmal — und erst,
    // wenn der Player meldet, dass er spielt.
    const posted: string[] = [];
    withFrame(posted);
    render(<VideoPane video={video} overview={overview} />);

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    expect(posted.some((m) => m.includes('seekTo'))).toBe(true);
    expect(posted.some((m) => m.includes('pauseVideo'))).toBe(false);
  });

  it('lässt ein LAUFENDES Video laufen', () => {
    const posted: string[] = [];
    withFrame(posted);
    render(<VideoPane video={video} overview={overview} />);
    act(() => { reportState(1); }); // 1 = spielt

    fireEvent.click(screen.getAllByTestId('video-chapter')[1]);

    expect(posted.some((m) => m.includes('pauseVideo'))).toBe(false);
  });
});

describe('VideoPane – Rückweg lässt die Markierung aufglühen', () => {
  it('wechselt in die richtige Ansicht und lässt genau diese Markierung glühen', () => {
    const start = video.transcript!.indexOf('this is the pre-training stage');
    const ref = { current: null } as React.RefObject<VideoPaneHandle | null>;
    render(
      <VideoPane
        video={video}
        overview={overview}
        ref={ref}
        transcriptHighlights={[
          {
            id: 'th7', videoId: 'v1', color: 'blue', text: 'this is the pre-training stage',
            startOffset: start, endOffset: start + 'this is the pre-training stage'.length,
            startSeconds: 450, childChatId: 'c9', source: 'transcript',
            createdAt: '2026-08-16T00:00:00Z', updatedAt: '2026-08-16T00:00:00Z',
          },
        ]}
      />,
    );

    vi.useFakeTimers();
    act(() => { ref.current!.showHighlight('th7'); });

    // Die Transcript-Ansicht ist sofort offen …
    expect(screen.getByTestId('video-transcript')).toBeInTheDocument();
    // … aber das Glühen wartet auf das Ende des Scrollens (Nutzerwunsch
    // 2026-08-16: „zuerst scrollen, dann glühen").
    expect(screen.getByTestId('transcript-highlight').getAttribute('data-flash')).toBeNull();

    // Zwei ruhige Messungen der Scrollposition = die Liste steht.
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId('transcript-highlight').getAttribute('data-flash')).toBe('true');

    // Und nachdem die Animation zu Ende gelaufen ist, ist wieder Ruhe. Der
    // Rückfall-Timer läuft absichtlich etwas länger als die Animation
    // (FLASH_MS + 400), damit der dritte Puls ausklingen darf.
    act(() => { vi.advanceTimersByTime(1800); });
    expect(screen.getByTestId('transcript-highlight').getAttribute('data-flash')).toBeNull();
  });
});
