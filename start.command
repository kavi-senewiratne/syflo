#!/bin/bash
# Syflo start script
# Starts Ollama, backend and frontend, opens the browser

set -e

SYFLO_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SYFLO_DIR/start.command"
LOG_DIR="$SYFLO_DIR/logs"
mkdir -p "$LOG_DIR"

cd "$SYFLO_DIR"

# When started via double-click (Finder/launchd, e.g. Syflo.app on the desktop)
# the script inherits NO shell profile — the PATH is only /usr/bin:/bin:…:
# neither Homebrew (ollama, docker, whisper-server) nor nvm (node, npm) can
# be found. So pull both into the PATH explicitly here instead of relying on
# .zshrc. nvm.sh is deliberately NOT sourced (plays badly with set -e) —
# the newest installed Node version is enough.
for p in /opt/homebrew/bin /usr/local/bin; do
  [[ -d "$p" && ":$PATH:" != *":$p:"* ]] && PATH="$p:$PATH"
done
if ! command -v npm >/dev/null 2>&1; then
  node_bin=$(ls -d "$HOME/.nvm/versions/node"/v*/bin 2>/dev/null | sort -V | tail -1)
  [[ -n "$node_bin" ]] && PATH="$node_bin:$PATH"
fi
export PATH
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found (neither in PATH nor under ~/.nvm)"
  exit 1
fi

# One value for all: Ollama uses it as the context window, the backend
# derives its character budget for the system context from it
# (ancestor-context.js). Exported so BOTH processes see the same value — a
# backend budget above the Ollama window would mean silent context shifting
# and a dead KV cache.
#
# 32768 instead of 16384 (2026-07-24): the backend budget grows automatically
# to ~97k characters, so most papers (e.g. Bengio 2003: 15.2k tokens) fall
# back into the fast full-text mode instead of retrieval — follow-up
# questions ~2 s instead of ~14 s, regardless of topic. Verified on the
# 24-GB Mac: qwen3.5:9b stays 100% on the GPU with the 32k window
# (9.7 GB, decode unchanged ~28 tok/s). Retrieval remains the safety net
# for monsters.
export OLLAMA_CONTEXT_LENGTH=32768

# FlashAttention: mathematically identical result, but computed tile by
# tile — faster prefill and less memory.
export OLLAMA_FLASH_ATTENTION=1

# Never unload models on idle (Ollama default: 5 min). An unload throws
# away the entire KV cache — the next question pays the full paper prefill
# (~60 s, measured 2026-07-25). The backend does re-pin for 1 h after
# every answer (messages.js), but -1 also protects all paths without
# re-pinning (e.g. after pure explain/embedding calls).
export OLLAMA_KEEP_ALIVE=-1

# Latency analysis (perf-log.js): leave commented out — enable only for
# measuring. Then the backend writes one JSON line per answer with pure
# metrics (mode, cache, tokens, timings; NEVER conversation content) to
# logs/perf.jsonl, analyzable with jq. The [perf] line in backend.log runs
# always anyway. The file can be deleted at any time.
# export SYFLO_PERF_LOG=1

# NO OLLAMA_KV_CACHE_TYPE=q8_0: qwen3.5 is a hybrid-attention model,
# and with a quantized KV cache the runner on Metal silently falls back to
# 100% CPU (measured 2026-07-24: 33/33 GPU layers → 0). Only reconsider
# when the model ladder switches to classic attention.

# No OLLAMA_NUM_PARALLEL: for vision models (our entire ladder) Ollama
# forces parallel:1 — there is exactly ONE KV cache slot. That is why all
# side calls (title generation) share the conversation's prompt prefix
# (messages.js) instead of evicting the expensive paper prefill.

echo "🚀 Starting Syflo..."
echo ""

# Recursively terminate a process along with all its descendants.
# Important because $BACKEND_PID/$FRONTEND_PID are only the bash subshell —
# npm and node run underneath. Without recursion, node/vite keep running
# as orphans and block ports 3001 / 5173.
kill_tree() {
  local parent=$1
  [[ -z "$parent" ]] && return
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$parent" 2>/dev/null || true
}

# Clean up on exit (Ctrl+C, Cmd+W, kill)
cleanup() {
  echo ""
  echo "Stopping Syflo..."
  kill_tree "$BACKEND_PID"
  kill_tree "$FRONTEND_PID"
  kill_tree "$OLLAMA_PID"
  # Safety net: terminate anything still listening on our ports
  # 8891 = whisper-server (dictation, ADR-0004) — started lazily by the
  # backend and, as its child, normally caught by kill_tree as well.
  for port in 3001 5173 5174 5175 5176 5177 5178 8891; do
    leftover=$(lsof -t -iTCP:$port -sTCP:LISTEN 2>/dev/null || true)
    [[ -n "$leftover" ]] && kill -TERM $leftover 2>/dev/null || true
  done
  echo "👋 Bye!"
  exit 0
}
trap cleanup INT TERM HUP

# Close previous instances: only bash processes executing exactly this
# script (excluding our own PID). This touches neither editors that have
# the script open nor other terminals (e.g. Claude).
own_pid=$$
killed_any=0
for pid in $(pgrep -f "$SCRIPT_PATH" 2>/dev/null || true); do
  [[ "$pid" == "$own_pid" ]] && continue
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *bash*"$SCRIPT_PATH"*|*sh*"$SCRIPT_PATH"*|"$SCRIPT_PATH"*)
      [[ "$killed_any" == 0 ]] && echo "Closing previous Syflo instances..."
      killed_any=1
      pid_tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ' || true)
      kill -TERM "$pid" 2>/dev/null || true
      # Close the associated Terminal window (best-effort, needs Automation permission)
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

# Orphaned dev servers from earlier instances (bug found 2026-08-10).
#
# The loop above only finds instances whose bash process still EXISTS. Force-
# quit the Terminal window, put the Mac to sleep, SIGKILL — and the trap never
# runs, so `npm run dev` and its `node --watch server.js` live on as orphans
# with no parent to match. Clearing the port below does not help either: the
# listener on 3001 is merely the CHILD of the watcher, and the moment it dies
# the watcher spawns a fresh one. The old instance therefore keeps competing
# for the port forever.
#
# Measured state on 2026-08-10: THREE watchers alive at once (from 31 July,
# 6 August and 9 August), all on the same folder. Which one won port 3001 was
# a race — it changed between two measurements an hour apart. The two losers
# still wrote "Syflo backend running on http://localhost:3001" into their own
# log after dying on EADDRINUSE, so the perf lines and the real log sat in
# different files and a diagnosis reads the wrong one.
#
# So kill the WATCHERS, not the listeners. Matched by command line AND working
# directory, so another checkout or an unrelated project is never touched.
stale_dev_pids() {
  local pid cwd
  {
    pgrep -f "node --watch server.js" 2>/dev/null || true
    pgrep -f "node .*/vite" 2>/dev/null || true
  } | sort -u | while read -r pid; do
    [[ -z "$pid" || "$pid" == "$own_pid" ]] && continue
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    [[ "$cwd" == "$SYFLO_DIR"* ]] && echo "$pid"
  done
}
stale=$(stale_dev_pids)
if [[ -n "$stale" ]]; then
  echo "Closing orphaned dev servers: PID $(echo $stale | tr '\n' ' ')"
  for pid in $stale; do
    kill_tree "$pid"
  done
  sleep 1
fi

# Safety net: terminate all processes still listening on our ports.
# Catches orphan processes from old/crashed instances — otherwise the new
# vite e.g. moves from 5173 to 5174 and the browser shows stale code.
# 8891 = whisper-server (dictation): started lazily by the backend, so an
# orphan outlives its parent and the new backend's instance cannot bind.
for port in 3001 5173 5174 5175 5176 5177 5178 8891; do
  leftover=$(lsof -t -iTCP:$port -sTCP:LISTEN 2>/dev/null || true)
  if [[ -n "$leftover" ]]; then
    echo "Clearing port $port (PID $leftover)..."
    kill -TERM $leftover 2>/dev/null || true
  fi
done
[[ "$killed_any" == 1 ]] || sleep 0.3

# Wait for an HTTP endpoint until it responds (or timeout).
# Returns 0 on success, 1 on timeout.
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
# Context window instead of the 4096 default: the chat gets the full text of
# the attached paper in the system prompt — with 4096, Ollama would silently
# cut off the paper text. Value: export at the top of the script.
start_ollama() {
  ollama serve >"$LOG_DIR/ollama.log" 2>&1 &
  OLLAMA_PID=$!
  if wait_for http://localhost:11434/api/tags 20; then
    echo "Ollama ready"
  else
    echo "Ollama is not responding (see $LOG_DIR/ollama.log)"
  fi
}
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  # An already running daemon has NOT inherited our exports — started
  # elsewhere (brew services, an old terminal) it would run with a 4096
  # window while the backend plans for ~97k characters: silent context
  # shifting, dead KV cache, cut-off papers (trap discovered 2026-07-24).
  # So check the daemon's env (ps -wwE) and restart it if necessary.
  running_pid=$(pgrep -f "ollama serve" | head -1 || true)
  running_env=$(ps -wwE -p "${running_pid:-0}" -o command= 2>/dev/null || true)
  if [[ "$running_env" == *"OLLAMA_CONTEXT_LENGTH=$OLLAMA_CONTEXT_LENGTH"* ]]; then
    echo "Ollama is already running (context window $OLLAMA_CONTEXT_LENGTH ok)"
  else
    echo "Ollama is running without our context window — restarting..."
    # A brew service would immediately revive the daemon with the old env
    # after a kill — so stop the service first (best effort).
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
    echo "ERROR: 'ollama' is not installed (brew install ollama)"
    exit 1
  fi
  echo "Starting Ollama..."
  start_ollama
fi

# 1.4 Embedding model for the retrieval mode of long papers (retrieval.js):
# multilingual, ~1.2 GB (bge-m3, ADR-0006 addendum), downloads in the background.
# If it is missing at runtime, the backend silently degrades to the old
# full-text truncation — nothing breaks.
if curl -s http://localhost:11434/api/tags 2>/dev/null | grep -q 'bge-m3'; then
  : # already present
else
  echo "Downloading embedding model bge-m3 (background)..."
  ollama pull bge-m3 >"$LOG_DIR/embed-pull.log" 2>&1 &
fi

# 1.5 SearXNG (web search in chat) — best effort: without a running container
# the web_search function dies silently (the model only gets an error
# string). No container runtime is NOT fatal — the chat keeps running,
# just without web search. Port 8890, see searxng/docker-compose.yml.
# The runtime is Colima (decision 2026-07-22): a lean VM (~1 GB cap)
# instead of Docker Desktop, autostart via `brew services start colima`. The
# colima start here is only the safety net in case the service is off.
if curl -s -m 2 http://localhost:8890/ >/dev/null 2>&1; then
  echo "SearXNG is already running"
elif command -v docker >/dev/null 2>&1; then
  if ! docker info >/dev/null 2>&1 && command -v colima >/dev/null 2>&1; then
    echo "Starting Colima..."
    colima start >"$LOG_DIR/colima.log" 2>&1 || true
  fi
  if docker info >/dev/null 2>&1; then
    echo "Starting SearXNG (port 8890)..."
    docker compose -f "$SYFLO_DIR/searxng/docker-compose.yml" up -d >"$LOG_DIR/searxng.log" 2>&1 \
      && echo "SearXNG ready" \
      || echo "SearXNG could not start (see $LOG_DIR/searxng.log) — web search disabled"
  else
    echo "No container runtime reachable (colima start failed?) — web search disabled"
  fi
else
  echo "Docker CLI is not installed — web search in chat is disabled"
fi

# 2. Backend
echo "Starting backend (port 3001)..."
(cd "$SYFLO_DIR/backend" && npm run dev) >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
if wait_for http://localhost:3001/api/chats 20; then
  echo "Backend ready"
else
  echo "Backend is not responding (see $LOG_DIR/backend.log)"
fi

# 3. Frontend
echo "Starting frontend (port 5173)..."
(cd "$SYFLO_DIR/frontend" && npm run dev) >"$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
if wait_for http://localhost:5173 30; then
  echo "Frontend ready"
else
  echo "Frontend is not responding (see $LOG_DIR/frontend.log)"
fi

echo ""
echo "✅ Syflo is running!"
echo "   Frontend: http://localhost:5173"
echo "   Backend:  http://localhost:3001"
echo "   Ollama:   http://localhost:11434"
echo "   Logs:     $LOG_DIR"
echo ""

# 4. Syflo window (Electron dev shell, loads the Vite server on :5173).
# Runs in the foreground: closing the window — or Ctrl+C here — shuts
# everything down via cleanup. Without Electron installed: browser as before.
if [[ -d "$SYFLO_DIR/electron/node_modules/electron" ]]; then
  echo "Opening Syflo window... (closing the window or Ctrl+C stops everything)"
  # Via LaunchServices (open) instead of spawning directly: this way
  # Electron.app itself is the process "responsible" for macOS permissions
  # and uses its own microphone grant (com.github.Electron, entry "Electron"
  # in System Settings). Started directly, the whole chain would inherit the
  # identity of the desktop launcher (local.syflo.launcher) — whose
  # microphone access macOS denied WITHOUT a prompt, and dictation recorded
  # exact silence (diagnosis 2026-07-24). -W waits until the window is
  # closed so cleanup shuts everything down afterwards.
  # electron.log is dropped in the process (open cannot redirect stdout).
  open -n -W "$SYFLO_DIR/electron/node_modules/electron/dist/Electron.app" \
    --args "$SYFLO_DIR/electron" || true
  cleanup
else
  echo "Electron is missing (cd electron && npm install) — opening browser..."
  open http://localhost:5173
  echo "Press Ctrl+C to stop."
  wait
fi
