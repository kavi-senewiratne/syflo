/**
 * audio/recorder.ts
 *
 * PCM-Recorder auf AudioWorklet-Basis (ADR-0004): zapft den getUserMedia-
 * Stream an, den useVoiceInput ohnehin für die Lautstärke-Wellenform öffnet —
 * es gibt nur noch EINEN Mikrofon-Konsumenten (früher konkurrierten Web
 * Speech API und AnalyserNode um das Mikro).
 *
 * Browser-only (AudioWorklet existiert nicht in jsdom); useVoiceInput bekommt
 * ihn deshalb als injizierbare recorderFactory — Tests reichen einen Fake.
 */

export interface PcmRecording {
  samples: Float32Array;
  sampleRate: number;
}

export interface PcmRecorder {
  start(): Promise<void>;
  stop(): Promise<PcmRecording>;
}

export function createWorkletRecorder(stream: MediaStream, ctx: AudioContext): PcmRecorder {
  let node: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  const chunks: Float32Array[] = [];

  return {
    async start() {
      await ctx.audioWorklet.addModule('/pcm-recorder-worklet.js');
      node = new AudioWorkletNode(ctx, 'pcm-recorder');
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        chunks.push(new Float32Array(e.data));
      };
      source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      // Nicht mit ctx.destination verbinden — wir wollen aufnehmen,
      // nicht das Mikro auf die Lautsprecher legen.
    },

    async stop() {
      try { source?.disconnect(); } catch { /* schon getrennt */ }
      try { node?.disconnect(); } catch { /* schon getrennt */ }
      node = null;
      source = null;

      const total = chunks.reduce((n, c) => n + c.length, 0);
      const samples = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        samples.set(c, offset);
        offset += c.length;
      }
      return { samples, sampleRate: ctx.sampleRate };
    },
  };
}
