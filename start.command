#!/bin/bash
# Syflo Start-Skript
# Startet Ollama, Backend und Frontend, öffnet den Browser

set -e

SYFLO_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SYFLO_DIR/start.command"
LOG_DIR="$SYFLO_DIR/logs"
mkdir -p "$LOG_DIR"

cd "$SYFLO_DIR"

# Beim Doppelklick-Start (Finder/launchd, z. B. Syflo.app auf dem Schreibtisch)
# erbt das Skript KEIN Shell-Profil — der PATH ist nur /usr/bin:/bin:…:
# weder Homebrew (ollama, docker, whisper-server) noch nvm (node, npm) sind
# auffindbar. Deshalb beide hier explizit in den PATH holen, statt sich auf
# die .zshrc zu verlassen. nvm.sh wird bewusst NICHT gesourct (verträgt sich
# schlecht mit set -e) — die neueste installierte Node-Version reicht.
for p in /opt/homebrew/bin /usr/local/bin; do
  [[ -d "$p" && ":$PATH:" != *":$p:"* ]] && PATH="$p:$PATH"
done
if ! command -v npm >/dev/null 2>&1; then
  node_bin=$(ls -d "$HOME/.nvm/versions/node"/v*/bin 2>/dev/null | sort -V | tail -1)
  [[ -n "$node_bin" ]] && PATH="$node_bin:$PATH"
fi
export PATH
if ! command -v npm >/dev/null 2>&1; then
  echo "FEHLER: npm nicht gefunden (weder im PATH noch unter ~/.nvm)"
  exit 1
fi

# Ein Wert für alle: Ollama nutzt ihn als Kontextfenster, das Backend leitet
# daraus sein Zeichen-Budget für den System-Kontext ab (ancestor-context.js).
# Exportiert, damit BEIDE Prozesse denselben Wert sehen — ein Backend-Budget
# über dem Ollama-Fenster hieße stilles Context-Shifting und toten KV-Cache.
#
# 32768 statt 16384 (2026-07-24): das Backend-Budget wächst automatisch mit
# auf ~97k Zeichen, wodurch die meisten Papers (z. B. Bengio 2003: 15,2k
# Tokens) wieder in den schnellen Volltext-Modus fallen statt in Retrieval —
# Folgefragen ~2 s statt ~14 s, unabhängig vom Thema. Auf dem 24-GB-Mac
# verifiziert: qwen3.5:9b bleibt mit 32k-Fenster zu 100 % auf der GPU
# (9,7 GB, Decode unverändert ~28 tok/s). Retrieval bleibt Netz für Monster.
export OLLAMA_CONTEXT_LENGTH=32768

# FlashAttention: mathematisch identisches Ergebnis, aber kachelweise
# berechnet — schnelleres Prefill und weniger Speicher.
export OLLAMA_FLASH_ATTENTION=1

# Modelle nie aus Idle entladen (Ollama-Default: 5 min). Ein Unload wirft
# den kompletten KV-Cache weg — die nächste Frage zahlt den vollen
# Paper-Prefill (~60 s, gemessen 2026-07-25). Das Backend pinnt zwar nach
# jeder Antwort 1 h nach (messages.js), -1 schützt aber auch alle Pfade
# ohne Re-Pinning (z. B. nach reinen explain-/Embedding-Aufrufen).
export OLLAMA_KEEP_ALIVE=-1

# Latenz-Analyse (perf-log.js): auskommentiert lassen — nur zum Messen
# einschalten. Dann schreibt das Backend pro Antwort eine JSON-Zeile mit
# reinen Metriken (Modus, Cache, Tokens, Zeiten; NIE Gesprächsinhalte) nach
# logs/perf.jsonl, auswertbar mit jq. Die [perf]-Zeile im backend.log läuft
# ohnehin immer. Datei jederzeit löschbar.
# export SYFLO_PERF_LOG=1

# KEIN OLLAMA_KV_CACHE_TYPE=q8_0: qwen3.5 ist ein Hybrid-Attention-Modell,
# und mit quantisiertem KV-Cache fällt der Runner auf Metal still auf
# 100 % CPU zurück (gemessen 2026-07-24: 33/33 GPU-Schichten → 0). Erst
# wieder erwägen, wenn die Modell-Leiter auf klassische Attention wechselt.

# Kein OLLAMA_NUM_PARALLEL: Ollama erzwingt bei Vision-Modellen (unsere
# ganze Leiter) Parallel:1 — es gibt genau EINEN KV-Cache-Slot. Deshalb
# teilen sich alle Nebenaufrufe (Titel-Generierung) den Prompt-Prefix des
# Gesprächs (messages.js), statt den teuren Paper-Prefill zu verdrängen.

echo "🚀 Syflo wird gestartet..."
echo ""

# Rekursiv einen Prozess samt aller Nachfahren beenden.
# Wichtig, weil $BACKEND_PID/$FRONTEND_PID nur die Bash-Subshell sind —
# darunter laufen npm und node. Ohne Rekursion bleiben node/vite als
# Waisen weiter und blockieren Port 3001 / 5173.
kill_tree() {
  local parent=$1
  [[ -z "$parent" ]] && return
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$parent" 2>/dev/null || true
}

# Aufräumen beim Beenden (Ctrl+C, Cmd+W, kill)
cleanup() {
  echo ""
  echo "Beende Syflo..."
  kill_tree "$BACKEND_PID"
  kill_tree "$FRONTEND_PID"
  kill_tree "$OLLAMA_PID"
  # Sicherheitsnetz: alles, was noch auf unseren Ports lauscht, beenden
  # 8891 = whisper-server (Diktat, ADR-0004) — wird vom Backend lazy
  # gestartet und hängt als dessen Kind normalerweise mit an kill_tree.
  for port in 3001 5173 5174 5175 5176 5177 5178 8891; do
    leftover=$(lsof -t -iTCP:$port -sTCP:LISTEN 2>/dev/null || true)
    [[ -n "$leftover" ]] && kill -TERM $leftover 2>/dev/null || true
  done
  echo "👋 Tschüss!"
  exit 0
}
trap cleanup INT TERM HUP

# Vorherige Instanzen schließen: nur Bash-Prozesse, die genau dieses Skript
# ausführen (eigene PID ausgenommen). Damit werden weder Editoren, die das
# Skript geöffnet haben, noch andere Terminals (z. B. Claude) angefasst.
own_pid=$$
killed_any=0
for pid in $(pgrep -f "$SCRIPT_PATH" 2>/dev/null || true); do
  [[ "$pid" == "$own_pid" ]] && continue
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *bash*"$SCRIPT_PATH"*|*sh*"$SCRIPT_PATH"*|"$SCRIPT_PATH"*)
      [[ "$killed_any" == 0 ]] && echo "Schließe vorherige Syflo-Instanzen..."
      killed_any=1
      pid_tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ' || true)
      kill -TERM "$pid" 2>/dev/null || true
      # Zugehöriges Terminal-Fenster schließen (best-effort, braucht Automation-Berechtigung)
      if [[ -n "$pid_tty" && "$pid_tty" != "??" && "$pid_tty" != "?" ]]; then
        osascript >/dev/null 2>&1 <<EOF || true
tell application "Terminal"
  try
    set wins to (every window whose tty is "/dev/$pid_tty")
    repeat with w in wins
      close w saving no
    end repeat
  end try
end tell
EOF
      fi
      ;;
  esac
done
[[ "$killed_any" == 1 ]] && sleep 1

# Sicherheitsnetz: alle Prozesse beenden, die noch auf unseren Ports lauschen.
# Fängt Waisen-Prozesse von alten/abgestürzten Instanzen ab — sonst weicht der
# neue vite z. B. von 5173 auf 5174 aus und der Browser zeigt veralteten Code.
for port in 3001 5173 5174 5175 5176 5177 5178; do
  leftover=$(lsof -t -iTCP:$port -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$leftover" ]]; then
    echo "Räume Port $port (PID $leftover)..."
    kill -TERM $leftover 2>/dev/null || true
  fi
done
[[ "$killed_any" == 1 ]] || sleep 0.3

# Auf einen HTTP-Endpoint warten, bis er antwortet (oder Timeout).
# Gibt 0 bei Erfolg, 1 bei Timeout zurück.
wait_for() {
  local url=$1 max_tries=${2:-30}
  for i in $(seq 1 "$max_tries"); do
    if curl -s -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# 1. Ollama
# Kontextfenster statt der 4096-Default: der Chat bekommt den Volltext des
# angehängten Papers in den System-Prompt — mit 4096 würde Ollama den
# Paper-Text stillschweigend abschneiden. Wert: export oben im Skript.
start_ollama() {
  ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
  OLLAMA_PID=$!
  if wait_for http://localhost:11434/api/tags 20; then
    echo "Ollama bereit"
  else
    echo "Ollama antwortet nicht (siehe $LOG_DIR/ollama.log)"
  fi
}
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  # Ein bereits laufender Daemon hat unsere Exports NICHT geerbt — fremd
  # gestartet (brew services, altes Terminal) liefe er mit 4096er-Fenster,
  # während das Backend mit ~97k Zeichen plant: stilles Context-Shifting,
  # toter KV-Cache, abgeschnittene Papers (Falle entdeckt 2026-07-24).
  # Deshalb die Env des Daemons prüfen (ps -wwE) und notfalls neu starten.
  running_pid=$(pgrep -f "ollama serve" | head -1 || true)
  running_env=$(ps -wwE -p "${running_pid:-0}" -o command= 2>/dev/null || true)
  if [[ "$running_env" == *"OLLAMA_CONTEXT_LENGTH=$OLLAMA_CONTEXT_LENGTH"* ]]; then
    echo "Ollama läuft bereits (Kontextfenster $OLLAMA_CONTEXT_LENGTH ok)"
  else
    echo "Ollama läuft ohne unser Kontextfenster — starte neu..."
    # Ein brew-Service würde den Daemon nach kill sofort mit alter Env
    # wiederbeleben — den Service deshalb zuerst stoppen (best effort).
    if launchctl list 2>/dev/null | grep -qi ollama; then
      brew services stop ollama >/dev/null 2>&1 || true
    fi
    { [[ -n "$running_pid" ]] && kill -TERM "$running_pid" 2>/dev/null; } || true
    for i in $(seq 1 20); do
      curl -s http://localhost:11434/api/tags >/dev/null 2>&1 || break
      sleep 0.5
    done
    start_ollama
  fi
else
  if ! command -v ollama >/dev/null 2>&1; then
    echo "FEHLER: 'ollama' ist nicht installiert (brew install ollama)"
    exit 1
  fi
  echo "Starte Ollama..."
  start_ollama
fi

# 1.4 Embedding-Modell für den Retrieval-Modus langer Papers (retrieval.js):
# winzig (~300 MB), lädt im Hintergrund. Fehlt es zur Laufzeit, degradiert
# das Backend still auf die alte Volltext-Kürzung — nichts bricht.
if curl -s http://localhost:11434/api/tags 2>/dev/null | grep -q 'nomic-embed-text'; then
  : # schon vorhanden
else
  echo "Lade Embedding-Modell nomic-embed-text (Hintergrund)..."
  ollama pull nomic-embed-text >"$LOG_DIR/embed-pull.log" 2>&1 &
fi

# 1.5 SearXNG (Web-Suche im Chat) — best effort: ohne laufenden Container
# stirbt die web_search-Funktion still (das Modell bekommt nur einen Fehler-
# String). Keine Container-Laufzeit ist NICHT fatal — der Chat läuft weiter,
# nur ohne Web-Suche. Port 8890, siehe searxng/docker-compose.yml.
# Laufzeit ist Colima (Entscheidung 2026-07-22): schlanke VM (~1 GB Deckel)
# statt Docker Desktop, Autostart über `brew services start colima`. Der
# colima-start hier ist nur das Sicherheitsnetz, falls der Dienst aus ist.
if curl -s -m 2 http://localhost:8890/ >/dev/null 2>&1; then
  echo "SearXNG läuft bereits"
elif command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1 && command -v colima >/dev/null 2>&1; then
    echo "Starte Colima..."
    colima start >"$LOG_DIR/colima.log" 2>&1 || true
  fi
  if docker info >/dev/null 2>&1; then
    echo "Starte SearXNG (Port 8890)..."
    docker compose -f "$SYFLO_DIR/searxng/docker-compose.yml" up -d >"$LOG_DIR/searxng.log" 2>&1 \
      && echo "SearXNG bereit" \
      || echo "SearXNG konnte nicht starten (siehe $LOG_DIR/searxng.log) — Web-Suche deaktiviert"
  else
    echo "Keine Container-Laufzeit erreichbar (colima start fehlgeschlagen?) — Web-Suche deaktiviert"
  fi
else
  echo "Docker-CLI ist nicht installiert — Web-Suche im Chat ist deaktiviert"
fi

# 2. Backend
echo "Starte Backend (Port 3001)..."
(cd "$SYFLO_DIR/backend" && npm run dev) >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
if wait_for http://localhost:3001/api/chats 20; then
  echo "Backend bereit"
else
  echo "Backend antwortet nicht (siehe $LOG_DIR/backend.log)"
fi

# 3. Frontend
echo "Starte Frontend (Port 5173)..."
(cd "$SYFLO_DIR/frontend" && npm run dev) >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
if wait_for http://localhost:5173 30; then
  echo "Frontend bereit"
else
  echo "Frontend antwortet nicht (siehe $LOG_DIR/frontend.log)"
fi

echo ""
echo "✅ Syflo läuft!"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3001"
echo "   Ollama:   http://localhost:11434"
echo "   Logs:     $LOG_DIR"
echo ""

# 4. Syflo-Fenster (Electron-Dev-Hülle, lädt den Vite-Server auf :5173).
# Läuft im Vordergrund: Fenster schließen — oder Ctrl+C hier — fährt über
# cleanup alles herunter. Ohne installiertes Electron: Browser wie früher.
if [[ -d "$SYFLO_DIR/electron/node_modules/electron" ]]; then
  echo "Öffne Syflo-Fenster... (Fenster schließen oder Ctrl+C beendet alles)"
  # Über LaunchServices (open) statt direkt gespawnt: so ist Electron.app
  # selbst der für macOS-Berechtigungen „verantwortliche Prozess" und nutzt
  # seine eigene Mikrofon-Freigabe (com.github.Electron, Eintrag „Electron"
  # in den Systemeinstellungen). Direkt gestartet erbte die ganze Kette die
  # Identität des Desktop-Launchers (local.syflo.launcher) — dessen
  # Mikrofonzugriff verweigerte macOS OHNE Prompt, und das Diktat nahm
  # exakte Stille auf (Diagnose 2026-07-24). -W wartet bis zum Schließen
  # des Fensters, damit cleanup danach alles herunterfährt.
  # electron.log entfällt dabei (open kann stdout nicht umleiten).
  open -n -W "$SYFLO_DIR/electron/node_modules/electron/dist/Electron.app" \
    --args "$SYFLO_DIR/electron" || true
  cleanup
else
  echo "Electron fehlt (cd electron && npm install) — öffne Browser..."
  open http://localhost:5173
  echo "Drücke Ctrl+C zum Beenden."
  wait
fi
