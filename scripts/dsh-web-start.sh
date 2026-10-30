#!/usr/bin/env bash
# Start the dsh web surface detached from the caller's session, then print the
# tokenized URL. A second start exits with the running instance's URL instead of
# binding a port that is already taken.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ELYSIA_LOG_DIR:-$ROOT/homes/web/logs}"
LOG=${ELYSIA_WEB_LOG:-$LOG_DIR/elyharn-web.log}
mkdir -p "$LOG_DIR"

if ss -tlnp 2>/dev/null | grep -q ':3299 '; then
  echo "[跳过] web 已在运行"
  grep -ohE 'http://127.0.0.1:3299/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1
  exit 0
fi

cd "$ROOT"
# Append across manual restarts to preserve startup diagnostics.
setsid bash scripts/dsh-web.sh --no-open --port 3299 >> "$LOG" 2>&1 < /dev/null &
echo "[启动] 等待就绪…"
sleep 18
if ! ss -tlnp 2>/dev/null | grep -q ':3299 '; then
  echo "[失败] 启动超时，日志："
  tail -20 "$LOG"
  exit 1
fi
grep -ohE 'http://127.0.0.1:3299/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | tail -1
