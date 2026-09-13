#!/usr/bin/env bash
#
# Start (or stop, or inspect) the easyeda-api bridge server.
#
# The bridge is a live code-execution channel into your EasyEDA client, so this
# script never runs on its own — you invoke it, and it tells you plainly what is
# listening and for how long. See SECURITY-PATCH.md.
#
# By default it starts the bridge *detached*: its own session, reparented to
# init, stdout appended to a log. That makes it outlive the shell — and any
# agent harness that reaps background tasks under memory pressure — so stopping
# it becomes a deliberate act too. Use --foreground to keep it attached.
#
# Usage:
#   scripts/start-bridge.sh [command] [options]
#
#   (no command)     Start the bridge if it is not already running
#   status           Report whether a bridge is listening, and its EDA windows
#   stop             Terminate a running bridge
#   restart          Stop, then start
#
#   -f, --foreground Run attached to this terminal instead of detaching
#       --log FILE   Where to append output (default ~/.easyeda-bridge/bridge.log)
#   -q, --quiet      Only print errors
#   -h, --help       Show this help

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────
# The server itself picks the first free port in this range; we only scan it.
PORT_START=49620
PORT_END=49629
SERVICE_ID="easyeda-bridge"

NODE_PREFIX="${EASYEDA_NODE_PREFIX:-$HOME/.local/share/easyeda-api-node}"
STATE_DIR="${EASYEDA_BRIDGE_HOME:-$HOME/.easyeda-bridge}"
LOG_FILE="$STATE_DIR/bridge.log"
TOKEN_FILE="$STATE_DIR/token"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVER_JS="$SKILL_DIR/scripts/bridge-server.mjs"

COMMAND="start"
FOREGROUND=0
QUIET=0

# ─── Output helpers ─────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()  { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
step()  { [ "$QUIET" = 1 ] || printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn()  { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()   { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
ok()    { [ "$QUIET" = 1 ] || printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }

usage() { sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ─── Argument parsing ───────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    start|status|stop|restart) COMMAND="$1" ;;
    -f|--foreground) FOREGROUND=1 ;;
    --log)           [ $# -ge 2 ] || die "--log needs a value"; LOG_FILE="$2"; shift ;;
    -q|--quiet)      QUIET=1 ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || die "need curl to probe the bridge"

# ─── Discovery ──────────────────────────────────────────────────────

# Echo the port a bridge of ours is listening on, or nothing.
# Matching on the service string rather than "something answered" keeps an
# unrelated local service on 49620 from being mistaken for the bridge.
find_bridge_port() {
  local port body
  for port in $(seq "$PORT_START" "$PORT_END"); do
    body="$(curl -s --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
    case "$body" in
      *"\"$SERVICE_ID\""*) printf '%s\n' "$port"; return 0 ;;
    esac
  done
  return 1
}

# Echo the PID of a running bridge process, or nothing.
find_bridge_pid() {
  pgrep -f "[b]ridge-server\.mjs" 2>/dev/null | head -1
}

# Read one field out of the /health JSON without requiring jq.
health_field() {
  # health_field <port> <key>
  curl -s --max-time 2 "http://127.0.0.1:$1/health" 2>/dev/null \
    | sed -n "s/.*\"$2\":\([^,}]*\).*/\1/p" | tr -d '"'
}

resolve_node() {
  local candidate
  for candidate in "$NODE_PREFIX/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  die "no node found. Run scripts/install.sh first, or put node on your PATH."
}

# ─── Commands ───────────────────────────────────────────────────────

do_status() {
  local port pid connected windows
  if ! port="$(find_bridge_port)"; then
    info "bridge: ${BOLD}not running${RESET}"
    pid="$(find_bridge_pid)"
    [ -n "$pid" ] && warn "a bridge process ($pid) exists but answers no health check"
    return 1
  fi

  pid="$(find_bridge_pid)"
  connected="$(health_field "$port" edaConnected)"
  windows="$(health_field "$port" edaWindowCount)"

  info "bridge:   ${GREEN}running${RESET} on port $port${pid:+ (pid $pid)}"
  [ -n "$pid" ] && info "uptime:   $(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
  info "token:    $TOKEN_FILE"
  info "log:      $LOG_FILE"

  if [ "$connected" = "true" ]; then
    info "eda:      ${GREEN}connected${RESET} ($windows window(s))"
  else
    info "eda:      ${YELLOW}no window attached${RESET}"
    info "          ${DIM}open EasyEDA and click API Gateway -> Reconnect${RESET}"
  fi
  return 0
}

do_stop() {
  local pid
  pid="$(find_bridge_pid)" || true
  if [ -z "$pid" ]; then
    info "bridge is not running — nothing to stop"
    return 0
  fi

  step "Stopping bridge (pid $pid)"
  kill "$pid" 2>/dev/null || die "could not signal pid $pid"

  # SIGTERM is enough for a node http server; give it a moment before escalating.
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "pid $pid ignored SIGTERM, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  ok "stopped"
}

do_start() {
  local port node pid

  # Starting a second bridge is not an error — it would bind the next free port
  # — but it is almost never what anyone wants, since the EDA extension attaches
  # to whichever it discovers first.
  if port="$(find_bridge_port)"; then
    info "bridge already running on port $port — not starting another"
    do_status
    return 0
  fi

  [ -f "$SERVER_JS" ] || die "cannot find $SERVER_JS"
  node="$(resolve_node)"
  mkdir -p "$STATE_DIR"

  if [ "$FOREGROUND" = 1 ]; then
    step "Starting bridge in the foreground (Ctrl-C to stop)"
    exec "$node" "$SERVER_JS"
  fi

  step "Starting bridge (detached, logging to $LOG_FILE)"
  # setsid: new session, so it survives this shell and any harness that reaps
  # our process group. </dev/null so it never blocks on stdin.
  setsid nohup "$node" "$SERVER_JS" >>"$LOG_FILE" 2>&1 </dev/null &
  disown 2>/dev/null || true

  # Poll rather than sleeping a fixed amount: startup is usually well under a
  # second, but a cold page cache can make it slower.
  local waited=0
  while [ "$waited" -lt 20 ]; do
    if port="$(find_bridge_port)"; then
      pid="$(find_bridge_pid)"
      ok "bridge listening on port $port${pid:+ (pid $pid)}"
      [ -f "$TOKEN_FILE" ] && ok "token written to $TOKEN_FILE"
      info ""
      do_status
      info ""
      info "${DIM}This is a code-execution channel into your EDA client."
      info "Stop it when you are done:  $0 stop${RESET}"
      return 0
    fi
    sleep 0.25
    waited=$((waited + 1))
  done

  warn "bridge did not answer within 5s — last lines of $LOG_FILE:"
  tail -15 "$LOG_FILE" >&2 2>/dev/null || true
  die "startup failed"
}

case "$COMMAND" in
  start)   do_start ;;
  status)  do_status ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
esac
