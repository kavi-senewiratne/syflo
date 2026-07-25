/**
 * audio/wav.ts
 *
 * Float32-PCM → 16-kHz-mono-16-bit-WAV. Whisper wurde auf 16 kHz trainiert
 * und whisper.cpp liest WAV nativ — wir liefern also exakt das Zielformat
 * und sparen uns jede Transcodierung im Backend (ADR-0004: kein ffmpeg).
 */

const TARGET_RATE = 16000;

/** Lineare Interpolation auf 16 kHz — für Sprache völlig ausreichend. */
function downsample(samples: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return samples;
  const ratio = inputRate / TARGET_RATE;
  const outLength = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = pos - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

export function encodeWav16kMono(samples: Float32Array, inputRate: number): ArrayBuffer {
  const pcm = downsample(samples, inputRate);
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);

  const writeAscii = (off: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(off + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);            // fmt-Chunk-Größe
  view.setUint16(20, 1, true);             // PCM
  view.setUint16(22, 1, true);             // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // Byte-Rate (mono, 16 bit)
  view.setUint16(32, 2, true);             // Block-Align
  view.setUint16(34, 16, true);            // Bits pro Sample
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);

  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return buf;
}
