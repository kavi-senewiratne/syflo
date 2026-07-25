/**
 * pcm-recorder-worklet.js
 *
 * AudioWorkletProcessor für die Diktierfunktion (ADR-0004): reicht jeden
 * 128-Sample-Block des ersten Eingangskanals als übertragenen ArrayBuffer an
 * den Main-Thread weiter. Kein Resampling hier — das macht encodeWav16kMono
 * einmalig beim Stoppen.
 */

class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Kopieren ist nötig: der Browser recycelt den Puffer des Frames.
      const copy = new Float32Array(channel);
      this.port.postMessage(copy.buffer, [copy.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorderProcessor);
