/**
 * useVoiceInput.test.ts
 *
 * Tests für useVoiceInput nach dem Whisper-Umbau (ADR-0004):
 * - Spacebar-PTT greift nur, wenn KEIN Text-Eingabefeld fokussiert ist.
 * - Audio wird während der Aufnahme gepuffert; erst beim Stoppen wird EIN
 *   WAV an POST /api/transcribe geschickt und der Servertext einmalig an
 *   onTranscript übergeben.
 * - isTranscribing überbrückt die Zeit zwischen Stopp und Server-Antwort.
 *
 * Der Recorder (AudioWorklet, browser-only) wird über recorderFactory
 * injiziert — gleiches Muster wie options.system/options.messages im Backend.
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { useVoiceInput } from '../hooks/useVoiceInput';
import type { PcmRecording } from '../audio/recorder';

// start/stop carry their real signatures: vitest 4's bare vi.fn() widens to
// Mock<Procedure | Constructable>, which no longer satisfies PcmRecorder.
let fakeRecorder: {
  started: boolean;
  samples: Float32Array;
  sampleRate: number;
  start: Mock<() => Promise<void>>;
  stop: Mock<() => Promise<PcmRecording>>;
};
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function makeFakeRecorder() {
  fakeRecorder = {
    started: false,
    samples: new Float32Array([0.1, 0.2, 0.3]),
    sampleRate: 16000,
    start: vi.fn<() => Promise<void>>(async () => { fakeRecorder.started = true; }),
    stop: vi.fn<() => Promise<PcmRecording>>(async () => ({
      samples: fakeRecorder.samples,
      sampleRate: fakeRecorder.sampleRate,
    })),
  };
  return fakeRecorder;
}

const recorderFactory = () => makeFakeRecorder();

function jsonResponse(text: string) {
  return { ok: true, json: async () => ({ text }) };
}

beforeEach(() => {
  const fakeTrack = { stop: vi.fn() };
  getUserMedia = vi.fn(async () => ({ getTracks: () => [fakeTrack] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  fetchMock = vi.fn(async () => jsonResponse(' hallo welt '));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as any).mediaDevices;
  vi.restoreAllMocks();
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function pressSpace(repeat = false) {
  const event = new KeyboardEvent('keydown', {
    code: 'Space',
    bubbles: true,
    cancelable: true,
    repeat,
  });
  document.dispatchEvent(event);
  return event;
}

function releaseSpace() {
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
}

describe('useVoiceInput – spacebar shortcut', () => {
  it('starts recording when spacebar is pressed with no focused element', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    act(() => { pressSpace(); });
    await act(async () => { await flush(); });

    expect(result.current.isListening).toBe(true);
    expect(fakeRecorder.started).toBe(true);
  });

  it('stops recording when spacebar is released', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    act(() => { pressSpace(); });
    await act(async () => { await flush(); });
    act(() => { releaseSpace(); });
    await act(async () => { await flush(); });

    expect(result.current.isListening).toBe(false);
    expect(fakeRecorder.stop).toHaveBeenCalledTimes(1);
  });

  it('does NOT start recording when a textarea is focused', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    act(() => { pressSpace(); });
    await act(async () => { await flush(); });

    expect(result.current.isListening).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  it('does NOT start recording on a key-repeat event (held key)', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    act(() => { pressSpace(true); });
    await act(async () => { await flush(); });

    expect(result.current.isListening).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  // Held spacebar used to page-scroll the PDF to its end: only the FIRST
  // keydown was preventDefault()ed, every auto-repeat fell through to the
  // browser's native "Space = page down".
  it('suppresses the native page scroll on every auto-repeat while held', async () => {
    const onTranscript = vi.fn();
    renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    let first: KeyboardEvent | undefined;
    act(() => { first = pressSpace(); });
    await act(async () => { await flush(); });
    expect(first!.defaultPrevented).toBe(true);

    for (let i = 0; i < 3; i++) {
      let repeated: KeyboardEvent | undefined;
      act(() => { repeated = pressSpace(true); });
      expect(repeated!.defaultPrevented).toBe(true);
    }
  });

  it('leaves the native page scroll alone when a textarea is focused', async () => {
    const onTranscript = vi.fn();
    renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    let event: KeyboardEvent | undefined;
    act(() => { event = pressSpace(); });
    expect(event!.defaultPrevented).toBe(false);

    document.body.removeChild(textarea);
  });

  it('does not start when enabled is false', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useVoiceInput({ onTranscript, enabled: false, recorderFactory }));

    act(() => { pressSpace(); });
    await act(async () => { await flush(); });

    expect(result.current.isListening).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe('useVoiceInput – Diktat wird beim Stoppen transkribiert', () => {
  it('sends ONE WAV to /api/transcribe on stop and emits the server text once', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    await act(async () => { result.current.startListening(); await flush(); });
    expect(onTranscript).not.toHaveBeenCalled(); // während der Aufnahme: nichts

    await act(async () => { result.current.stopListening(); await flush(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/transcribe');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('audio/wav');
    expect(init.body).toBeInstanceOf(ArrayBuffer);

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith('hallo welt'); // getrimmt
  });

  it('does not call the server when no audio was captured', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    await act(async () => { result.current.startListening(); await flush(); });
    fakeRecorder.samples = new Float32Array(0);
    await act(async () => { result.current.stopListening(); await flush(); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('does not emit when the server returns empty text', async () => {
    const onTranscript = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse('  '));
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    await act(async () => { result.current.startListening(); await flush(); });
    await act(async () => { result.current.stopListening(); await flush(); });

    expect(onTranscript).not.toHaveBeenCalled();
  });

  it('exposes isTranscribing while the server call is pending', async () => {
    const onTranscript = vi.fn();
    let resolveFetch: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(r => { resolveFetch = r; }));
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    await act(async () => { result.current.startListening(); await flush(); });
    expect(result.current.isTranscribing).toBe(false);

    await act(async () => { result.current.stopListening(); await flush(); });
    expect(result.current.isTranscribing).toBe(true);

    await act(async () => { resolveFetch!(jsonResponse('fertig')); await flush(); });
    expect(result.current.isTranscribing).toBe(false);
    expect(onTranscript).toHaveBeenCalledWith('fertig');
  });

  it('recovers when the transcription request fails', async () => {
    const onTranscript = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('backend down'));
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    await act(async () => { result.current.startListening(); await flush(); });
    await act(async () => { result.current.stopListening(); await flush(); });

    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.isTranscribing).toBe(false);
    expect(errorSpy).toHaveBeenCalled();

    // Nächstes Diktat funktioniert wieder
    await act(async () => { result.current.startListening(); await flush(); });
    await act(async () => { result.current.stopListening(); await flush(); });
    expect(onTranscript).toHaveBeenCalledWith('hallo welt');
  });

  it('toggle: a second recording produces a second transcript', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useVoiceInput({ onTranscript, recorderFactory }));

    await act(async () => { result.current.startListening(); await flush(); });
    await act(async () => { result.current.stopListening(); await flush(); });

    fetchMock.mockResolvedValueOnce(jsonResponse('zweiter text'));
    await act(async () => { result.current.startListening(); await flush(); });
    await act(async () => { result.current.stopListening(); await flush(); });

    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenLastCalledWith('zweiter text');
  });
});
