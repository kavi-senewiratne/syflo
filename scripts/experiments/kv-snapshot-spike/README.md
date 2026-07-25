# KV-Snapshot-Spike (2026-07-25)

Sandbox-Benchmark zur Frage: Kann ein gebündelter `llama-server` mit Slot
Save/Restore („ein Baum = eine Spielstand-Datei") den Paper-Prefill dauerhaft
machen? **Ergebnis: No-Go** — Begründung, Zahlen und Wiedervorlage-Kriterium in
`docs/adr/0007-no-llama-server-sidecar.md`.

## Dateien

- `phaseA.mjs` — Benchmark-Skript (`node phaseA.mjs ollama | llama | probe | tools-check`).
  Pfade oben in der Datei anpassen (GGUF, Paper-Text, Scratch-Verzeichnis).
- `results.jsonl` — finale Läufe: Ollama-Referenz + llama-server ohne Thinking.
- `results-v1-maxtok150.jsonl` — verworfener Erstlauf mit hartem max_tokens=150.
  Nebenbefund von bleibendem Wert: gekappte Antworten in der Historie kosten
  beim Hybrid-Modell 82–103 s pro Folgefrage (Cache nie wieder warm).
- `results-llama-thinking-run.jsonl` — Lauf, bei dem `--reasoning-budget 0`
  wirkungslos blieb (qwen3.5 dachte ~2,5k Zeichen pro Antwort); Thinking
  zuverlässig aus nur via `chat_template_kwargs: {enable_thinking: false}`.

## Wiederholung nach llama.cpp-Fix

```
brew upgrade llama.cpp
node phaseA.mjs probe   # Erfolg = cache_n > 0 nach Restore, Folgefrage < 10 s
```
