#!/bin/bash
# agent-bridge 启动脚本：幂等，端口已在监听就跳过。
# 即开即用：bash .devcontainer/agent-bridge/start.sh
set -u

# 用脚本自身所在目录定位 server.mjs —— 仓库在哪都能跑，不依赖 $HOME 里的安装
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${AGENT_BRIDGE_PORT:-8787}"
STATE="$HOME/.agent-bridge"
LOG="$STATE/bridge.log"
mkdir -p "$STATE"

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "[agent-bridge] 端口 $PORT 已在监听，跳过启动"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[agent-bridge] 找不到 node，请先确认容器里有 Node.js"
  exit 1
fi

nohup node "$HERE/server.mjs" >>"$LOG" 2>&1 &
echo "[agent-bridge] 已后台启动（PID $!）"
echo "[agent-bridge] 日志：$LOG"

# 等端口起来后把令牌打出来，方便直接填进设置页
for _ in $(seq 1 30); do
  sleep 0.2
  if [ -f "$STATE/token" ]; then
    echo "[agent-bridge] 桥接令牌：$(cat "$STATE/token")"
    break
  fi
done
