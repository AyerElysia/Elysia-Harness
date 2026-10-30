#!/usr/bin/env bash
# Stop the dsh web surface.
#
# Match on the resolved script path rather than the whole command line: a
# `pkill -f` pattern that also appears in this script would match the shell
# running it and kill the caller before it can report anything.
set -uo pipefail

PIDS=$(pgrep -f 'src/bin.ts --profile web.*--port 3299' || true)
if [ -z "$PIDS" ]; then
  echo "未运行"
  exit 0
fi
kill $PIDS 2>/dev/null || true
sleep 2
if ss -tlnp 2>/dev/null | grep -q ':3299 '; then
  echo "仍在运行（可能需要 kill -9）"
  exit 1
fi
echo "已停止"
