import { useEffect, useRef, useState } from 'react';
import { useStrings } from '../../strings';

interface Props {
  // Aktuelle Mikrofon-Lautstärke (0..1) — kommt aus useVoiceInput.
  volume: number;
  // Anzahl der Balken in der Welle.
  bars?: number;
  // Maximalhöhe in px.
  height?: number;
}

// Stilisierte ChatGPT-ähnliche Sprach-Welle: schmale Balken, deren Höhe von
// der echten Mikrofon-Lautstärke modelliert wird, mit einer leichten
// Sinus-Modulation für ein lebendiges Hin-und-Her statt eines starren
// VU-Meters.
export function VoiceWaveform({ volume, bars = 24, height = 36 }: Props) {
  const S = useStrings().chatArea;
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const loop = () => {
      setTick(t => t + 1);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Mindest-Idle, damit auch Stille leise wackelt — bewusst niedrig gewählt,
  // sonst klebt der Balken am Boden und Lautstärke-Variationen werden
  // unsichtbar.
  const idle = 0.05;
  const driven = Math.max(idle, volume);

  return (
    <div
      className="flex items-center justify-center gap-[3px] w-full"
      style={{ height }}
      data-testid="voice-waveform"
      aria-label={S.recordingVolumeAria}
      role="img"
    >
      {Array.from({ length: bars }).map((_, i) => {
        // Jeder Balken bekommt eine eigene Phase, damit die Welle "rollt"
        // statt synchron zu pulsieren.
        const phase = tick / 10 + i * 0.45;
        const wave = (Math.sin(phase) + 1) / 2; // 0..1
        // Mittlere Balken sollen höher schwingen können als die am Rand,
        // damit die Welle eine schöne Hüllkurve hat.
        const center = bars / 2;
        const distFromCenter = Math.abs(i - center) / center; // 0..1
        const envelope = 1 - distFromCenter * 0.55;
        const h = Math.max(0.08, driven * envelope * (0.6 + 0.7 * wave));
        return (
          <div
            key={i}
            // Akzentfarbe als var statt bg-blue-500: die unlayered Regeln in
            // index.css (`.bg-blue-500:not(.w-2)` u. a.) würden jedem Balken
            // einen Cartoon-Offset-Schatten verpassen.
            className="w-1 rounded-full bg-[var(--color-blue-500)]"
            style={{
              height: `${Math.min(100, h * 100)}%`,
            }}
          />
        );
      })}
    </div>
  );
}
