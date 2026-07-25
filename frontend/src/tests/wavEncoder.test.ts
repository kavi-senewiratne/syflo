/**
 * wavEncoder.test.ts
 *
 * encodeWav16kMono: Float32-Samples (beliebige Eingangs-Abtastrate) →
 * 16-kHz-mono-16-bit-WAV — exakt das Format, das whisper.cpp nativ liest
 * (ADR-0004). Reine Funktion, daher direkt testbar.
 */

import { describe, it, expect } from 'vitest';
import { encodeWav16kMono } from '../audio/wav';

function header(buf: ArrayBuffer) {
  const view = new DataView(buf);
  const ascii = (off: number, len: number) =>
    String.fromCharCode(...new Uint8Array(buf, off, len));
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataTag: ascii(36, 4),
    dataLen: view.getUint32(40, true),
  };
}

describe('encodeWav16kMono', () => {
  it('produces a valid 16 kHz mono 16-bit PCM WAV header', () => {
    const samples = new Float32Array(16000); // 1 s Stille bei 16 kHz
    const buf = encodeWav16kMono(samples, 16000);

    const h = header(buf);
    expect(h.riff).toBe('RIFF');
    expect(h.wave).toBe('WAVE');
    expect(h.fmt).toBe('fmt ');
    expect(h.audioFormat).toBe(1); // PCM
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(16000);
    expect(h.bitsPerSample).toBe(16);
    expect(h.dataTag).toBe('data');
    expect(h.dataLen).toBe(16000 * 2);
    expect(buf.byteLength).toBe(44 + 16000 * 2);
  });

  it('downsamples 48 kHz input to 16 kHz', () => {
    const samples = new Float32Array(48000); // 1 s bei 48 kHz
    const buf = encodeWav16kMono(samples, 48000);
    expect(header(buf).dataLen).toBe(16000 * 2);
  });

  it('converts sample values to 16-bit PCM and clamps out-of-range values', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 2, -2]);
    const buf = encodeWav16kMono(samples, 16000);
    const view = new DataView(buf);
    const pcm = (i: number) => view.getInt16(44 + i * 2, true);

    expect(pcm(0)).toBe(0);
    expect(pcm(1)).toBeCloseTo(16383, -1); // 0.5 * 0x7FFF
    expect(pcm(2)).toBeCloseTo(-16384, -1);
    expect(pcm(3)).toBe(32767);  // geclampt
    expect(pcm(4)).toBe(-32768); // geclampt
  });
});
