#!/bin/sh
# 一键启动（Linux/macOS）：代理绕过 → 挑空闲端口 → 前台起服务（就绪后自动打开浏览器）
# 自定义起始端口：DUAL_AGENT_PORT=3800 ./start.sh
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || { echo "未检测到 Node.js，请先安装 18+ 版本：https://nodejs.org/"; exit 1; }

# 代理工具兼容（Clash 等）：仅本进程直连 localhost，不改系统设置
export NO_PROXY=localhost,127.0.0.1
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true

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

echo "正在启动 dual-agent（端口 $PORT，就绪后自动打开浏览器）"
echo "全部网页关闭且无任务执行时，约 1 分钟后自动退出；Ctrl+C 立即停止"
# 前台运行：Ctrl+C 优雅退出
exec node server.js --port "$PORT"
