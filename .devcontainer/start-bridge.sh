#!/usr/bin/env bash
# Codespace 启动时自动拉起 Agent 桥接服务（幂等：已运行就直接退出）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 0

LOG="$HOME/agent-bridge.log"
PIDFILE="/tmp/agent-bridge.pid"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "[agent-bridge] 已在运行（pid $(cat "$PIDFILE")）"
  exit 0
fi

nohup node "$ROOT/codespace-bridge/server.mjs" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 1

echo "[agent-bridge] 已启动，日志：$LOG"
tail -n 12 "$LOG" 2>/dev/null || true
