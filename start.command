#!/bin/sh
# 一键启动（Linux/macOS 通用）：自动挑空闲端口 → 后台起服务 → 就绪后打开浏览器
# 自定义起始端口：DUAL_AGENT_PORT=3800 ./start.sh
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || { echo "未检测到 Node.js，请先安装 18+ 版本：https://nodejs.org/"; exit 1; }

PORT="${DUAL_AGENT_PORT:-3788}"
TRIES=0

while true; do
  if node tools/probe.js "$PORT" free >/dev/null 2>&1; then break; fi
  # 端口有响应：若已是本程序在跑，直接开浏览器复用
  if node tools/probe.js "$PORT" ours >/dev/null 2>&1; then
    echo "服务已在运行，打开 http://localhost:$PORT/"
    (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/") || true
    exit 0
  fi
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -gt 8 ]; then echo "端口 3788-3796 都被其他程序占用"; exit 1; fi
  PORT=$((PORT + 1))
done

node server.js --port "$PORT" &
SRV=$!
trap 'kill "$SRV" 2>/dev/null' EXIT
echo "正在启动 dual-agent（端口 $PORT）..."

W=45
while [ "$W" -gt 0 ]; do
  sleep 2
  if node tools/probe.js "$PORT" ready >/dev/null 2>&1; then
    echo "服务已就绪：http://localhost:$PORT/ （Ctrl+C 停止）"
    (command -v open >/dev/null && open "http://localhost:$PORT/") || (command -v xdg-open >/dev/null && xdg-open "http://localhost:$PORT/") || true
    wait "$SRV"
    exit 0
  fi
  W=$((W - 1))
done
echo "服务 90 秒未就绪，请手动运行 node server.js --port $PORT 查看报错"
exit 1
