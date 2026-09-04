#!/bin/bash
# 构建 Android 前置：同步 dual-agent 工程文件与 nodejs-mobile 原生库到 app 模块
# 用法：android/copy-assets.sh [nodejs-mobile解压目录]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-/tmp/opencode/nodejs-mobile}"
APP="$ROOT/android/app"
ASSETS="$APP/src/main/assets/nodejs-project"
NATIVE="$APP/src/main/assets/native"
CPPN="$APP/src/main/cpp/nodejs-mobile"

echo "[copy-assets] dual-agent -> assets（files 白名单同 npm 包）"
mkdir -p "$ASSETS" "$NATIVE" "$CPPN"
cd "$ROOT"

# npm files 白名单同步（与 package.json 保持一致：入口/核心/插件/前端/技能库/文档）
rsync -a --delete \
  --include='server.js' --include='mobile-main.js' --include='package.json' --include='LICENSE' --include='README.md' \
  --include='lib/' --include='lib/**' \
  --include='hwj/' --include='hwj/**' \
  --include='plugins/' --include='plugins/**' \
  --include='public/' --include='public/**' \
  --include='tools/' --include='tools/**' \
  --include='skills/' --include='skills/**' \
  --exclude='*' \
  ./ "$ASSETS/"

# 打包排除项：workspaces/.data 属运行期数据；test/docs 不进 App
rm -rf "$ASSETS/workspaces" "$ASSETS/.data"

# LLM 内置：.data/config.json（gitignore，本机私有）打包为 assets/llm-config.json，
# 由 mobile-main.js 首启动预置到 App 私有 data 目录。无配置时放占位模板（设置页可填）。
if [ -f "$ROOT/.data/config.json" ]; then
  cp "$ROOT/.data/config.json" "$ASSETS/llm-config.json"
  echo "[copy-assets] LLM 配置已内置（来源 .data/config.json）"
else
  printf '{\n  "inner": { "base_url": "", "api_key": "", "model": "" }\n}\n' > "$ASSETS/llm-config.json"
  echo "[copy-assets] 未发现 .data/config.json，已内置占位配置"
fi

echo "[copy-assets] libnode.so -> assets/native（运行期释放）+ cpp/nodejs-mobile（链接）"
for ABI in arm64-v8a x86_64; do
  mkdir -p "$NATIVE/$ABI" "$CPPN/$ABI"
  cp "$SRC/bin/$ABI/libnode.so" "$NATIVE/$ABI/libnode.so"
  cp "$SRC/bin/$ABI/libnode.so" "$CPPN/$ABI/libnode.so"
done
cp -r "$SRC/include" "$CPPN/"

echo "[copy-assets] 完成：$(find "$ASSETS" -type f | wc -l) 工程文件，libnode $(du -sh "$NATIVE" | cut -f1)"
