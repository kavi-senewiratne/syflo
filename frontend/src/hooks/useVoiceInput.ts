/**
 * hooks/useVoiceInput.ts
 *
 * Diktierfunktion mit ChatGPT-ähnlichem Klick-Toggle-Verhalten, seit
 * ADR-0004 auf lokalem Whisper statt der Web Speech API:
 *   - startListening() startet, stopListening() stoppt
 *   - während der Aufnahme werden die PCM-Samples gepuffert; erst beim
 *     Stoppen wird EIN WAV (16 kHz mono) an POST /api/transcribe geschickt
 *     und der erkannte Text als ein Block per onTranscript übergeben.
 *     Whisper erkennt Deutsch/Englisch selbst (language=auto im Backend),
 *     gemischte Sätze eingeschlossen.
 *   - isTranscribing überbrückt die Zeit zwischen Stopp und Server-Antwort
 *   - parallel läuft ein AnalyserNode auf demselben Mikrofon-Stream, damit
 *     `volume` (0..1) die Lautstärken-Wellen-Visualisierung speist
 *   - Spacebar als Push-to-Talk: greift NUR, wenn aktuell KEIN Text-
 *     Eingabefeld fokussiert ist — sonst tippt die Leertaste normal.
 *     Im Chat-Composer unterscheidet ChatArea zusätzlich Tipp vs. Halten
 *     (SPACE_HOLD_MS), damit Halten auch MIT fokussiertem Eingabefeld
 *     diktiert; der globale keyup-Handler hier stoppt beide Varianten.
 *
 * recorderFactory ist injizierbar (Tests: Fake statt AudioWorklet) —
 * gleiches Muster wie options.system/options.messages im Backend.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { createWorkletRecorder, type PcmRecorder } from '../audio/recorder';
import { encodeWav16kMono } from '../audio/wav';

interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  enabled?: boolean;
  /** Nur für Tests: ersetzt den AudioWorklet-Recorder durch einen Fake. */
  recorderFactory?: (stream: MediaStream, ctx: AudioContext | null) => PcmRecorder;
}

export function useVoiceInput({
  onTranscript,
  enabled = true,
  recorderFactory,
}: UseVoiceInputOptions) {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  // Aktuelle Mikrofon-Lautstärke 0..1, wird ~60×/s aktualisiert.
  const [volume, setVolume] = useState(0);
  const [supported, setSupported] = useState(false);

  const listeningRef = useRef(false);
  const recorderRef = useRef<PcmRecorder | null>(null);

  // Aktuelle Callback-/Factory-Referenzen, damit start/stop stabile
  // Identitäten behalten und trotzdem die neueste Version aufrufen.
  const onTranscriptRef = useRef(onTranscript);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  const recorderFactoryRef = useRef(recorderFactory);
  useEffect(() => { recorderFactoryRef.current = recorderFactory; }, [recorderFactory]);

  // Web-Audio-Ressourcen für Lautstärken-Erkennung.
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    setSupported(!!navigator.mediaDevices?.getUserMedia);
  }, []);

  const teardownAudio = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* schon zu */ }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setVolume(0);
  }, []);

  // Lautstärke-Analyser auf dem bereits geöffneten Stream — rein visuell,
  // Fehler hier dürfen die Aufnahme nie verhindern.
  const setupAudioAnalyser = useCallback((stream: MediaStream) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      // Höher = mehr Glättung der Frequenzdaten direkt in der Web Audio API.
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const speechBins = Math.max(8, Math.floor(dataArray.length * 0.25));
      // Exponentielles Glätten: aktueller Wert mischt sich mit dem letzten.
      let smoothed = 0;
      const alpha = 0.25;
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < speechBins; i++) sum += dataArray[i];
        const avg = sum / speechBins / 255;
        const target = Math.min(1, avg * 5);
        smoothed = smoothed * (1 - alpha) + target * alpha;
        setVolume(smoothed);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      console.error('[useVoiceInput] audio analyser setup failed', e);
    }
  }, []);

  const startListening = useCallback(() => {
    if (listeningRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) return;
    listeningRef.current = true;
    setIsListening(true);

    // KRITISCH: AudioContext synchron im User-Gesture-Stack erstellen.
    // Nach dem async getUserMedia gilt der Klick nicht mehr als Gesture und
    // der Context startet "suspended" — der Analyser liefert dann nur Stille.
    const AudioCtx: typeof AudioContext | undefined =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx && !audioContextRef.current) {
      try {
        const ctx = new AudioCtx();
        audioContextRef.current = ctx;
        if (ctx.state === 'suspended') {
          ctx.resume().catch(e => console.error('[useVoiceInput] resume failed', e));
        }
      } catch (e) {
        console.error('[useVoiceInput] AudioContext create failed', e);
      }
    }

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!listeningRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        setupAudioAnalyser(stream);

        const factory = recorderFactoryRef.current
          ?? ((s: MediaStream, ctx: AudioContext | null) => {
            if (!ctx) throw new Error('AudioContext unavailable');
            return createWorkletRecorder(s, ctx);
          });
        const recorder = factory(stream, audioContextRef.current);
        await recorder.start();
        if (!listeningRef.current) {
          // Nutzer hat schon wieder gestoppt, bevor der Worklet geladen war.
          await recorder.stop().catch(() => {});
          return;
        }
        recorderRef.current = recorder;
      } catch (e) {
        console.error('[useVoiceInput] start failed', e);
        listeningRef.current = false;
        setIsListening(false);
        teardownAudio();
      }
    })();
  }, [setupAudioAnalyser, teardownAudio]);

  const stopListening = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setIsListening(false);

    const recorder = recorderRef.current;
    recorderRef.current = null;

    (async () => {
      try {
        // Erst die Samples einsammeln, DANN den AudioContext schließen —
        // andersherum verliert der Worklet seine letzten Blöcke.
        const recording = recorder ? await recorder.stop() : null;
        teardownAudio();
        if (!recording || recording.samples.length === 0) return;

        const wav = encodeWav16kMono(recording.samples, recording.sampleRate);
        setIsTranscribing(true);
        try {
          const res = await fetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: wav,
          });
          if (!res.ok) {
            const detail = await res.json().catch(() => ({} as { error?: string }));
            throw new Error(detail.error || `transcribe answered ${res.status}`);
          }
          const { text } = await res.json();
          const trimmed = (text || '').trim();
          if (trimmed) onTranscriptRef.current(trimmed);
        } finally {
          setIsTranscribing(false);
        }
      } catch (e) {
        console.error('[useVoiceInput] transcription failed', e);
        teardownAudio();
      }
    })();
  }, [teardownAudio]);

  // Spacebar-Shortcut: nur, wenn KEIN Text-Eingabefeld fokussiert ist —
  // sonst würde Leertaste mitten im Tippen die Aufnahme starten und
  // verhindern, dass Leerzeichen im Text landen.
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const active = document.activeElement;
      const isTextInput =
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (isTextInput) return;
      // Outside a text field the browser reads Space as "page down". Holding
      // the key for push-to-talk fires auto-repeat keydowns, so every single
      // one has to be suppressed — otherwise a held Space scrolls the PDF to
      // its last page while the recording runs.
      e.preventDefault();
      if (e.repeat) return;
      startListening();
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (listeningRef.current) stopListening();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, [enabled, startListening, stopListening]);

  return { isListening, isTranscribing, volume, supported, startListening, stopListening };
}
