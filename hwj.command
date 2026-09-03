#!/bin/bash
# hwj 终端智能体 — macOS/Linux 双击启动（系统终端执行本脚本）
set -u
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[hwj] 未安装 Node.js（需要 18+）。安装方法："
  echo "  macOS:  brew install node"
  echo "  Linux:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  read -r -p "按回车键关闭…" _
  exit 1
fi
v=$(node -v 2>/dev/null | sed 's/v//;s/\..*//')
if [ "${v:-0}" -lt 18 ]; then
  echo "[hwj] Node.js 版本低于 18（当前 $(node -v)），请升级后重试"
  read -r -p "按回车键关闭…" _
  exit 1
fi

exec node hwj/hwj.js "$@"
