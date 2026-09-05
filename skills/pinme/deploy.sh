#!/usr/bin/env bash
# PinMe 长期静态发布脚本（IPFS 持久在线）——发布前强制预检：体积/文件数/敏感文件，超限不发布
# 用法: bash deploy.sh <产物目录或文件> [--domain <名称>] [--dns] [-- 直接透传更多 pinme 参数]
# 依赖: bash / node / pinme（npm i -g pinme；首次使用需 pinme set-appkey <AppKey>）

set -euo pipefail

# 限额：平台硬性值来自 CLI 源码 FILE_SIZE_LIMIT/DIRECTORY_SIZE_LIMIT（单文件 500MB、目录总量 500MB）；
# 可用环境变量覆盖（测试注入小限额）
MAX_TOTAL="${PINME_MAX_TOTAL_BYTES:-$((500 * 1024 * 1024))}"
MAX_FILE="${PINME_MAX_FILE_BYTES:-$((500 * 1024 * 1024))}"

usage() { echo "用法: bash deploy.sh <目录或文件> [--domain <名称>] [--dns]"; exit 2; }
[ $# -ge 1 ] || usage

SRC="$1"; shift
DOMAIN_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN_ARGS+=("--domain" "$2"); shift 2 ;;
    --dns) DOMAIN_ARGS+=("--dns"); shift ;;
    *) shift ;;
  esac
done

[ -e "$SRC" ] || { echo "错误：$SRC 不存在"; exit 1; }

human() { du -h "$1" 2>/dev/null | cut -f1; }

if [ -d "$SRC" ]; then
  # 文件数与总体积预检（目录模式）
  FILE_COUNT=$(find "$SRC" -type f | wc -l)
  TOTAL_BYTES=$(du -sb "$SRC" | cut -f1)
  if [ "$TOTAL_BYTES" -gt "$MAX_TOTAL" ]; then
    echo "错误：目录总体积 $(human "$SRC") 超过上限（$MAX_TOTAL 字节），已中止发布。"
    echo "建议：剔除大文件（视频/数据集），或拆分多次发布。"
    exit 1
  fi
  # 最大单文件预检
  BIGGEST=$(find "$SRC" -type f -exec du -b {} + 2>/dev/null | sort -rn | head -1)
  BIG_BYTES=$(echo "$BIGGEST" | cut -f1)
  BIG_PATH=$(echo "$BIGGEST" | cut -f2-)
  if [ -n "$BIG_BYTES" ] && [ "$BIG_BYTES" -gt "$MAX_FILE" ]; then
    echo "错误：单文件 $BIG_PATH（$(numfmt --to=iec 2>/dev/null <<< "$BIG_BYTES" || echo "${BIG_BYTES}B")）超过单文件上限（$MAX_FILE 字节），已中止发布。"
    echo "建议：压缩、拆分或改用其他分发渠道。"
    exit 1
  fi
  echo "预检通过：$FILE_COUNT 个文件，总体积 $(human "$SRC")"
else
  # 单文件模式
  F_BYTES=$(wc -c < "$SRC")
  if [ "$F_BYTES" -gt "$MAX_FILE" ]; then
    echo "错误：文件 $(human "$SRC") 超过单文件上限（$MAX_FILE 字节），已中止发布。"
    exit 1
  fi
  echo "预检通过：单文件 $(human "$SRC")"
fi

# 安全检查：敏感文件/不该上传的目录一票否决（IPFS 公开且不可撤回）
if [ -d "$SRC" ]; then
  if find "$SRC" \( -name '.env*' -o -name '*.pem' -o -name '*token*' -o -name '*secret*' -o -name '*.key' -o -name 'node_modules' -o -name '.git' \) | grep -q .; then
    echo "错误：目录中检测到疑似敏感文件或禁传目录（.env/密钥/token/secret/node_modules/.git），已中止。"
    find "$SRC" \( -name '.env*' -o -name '*.pem' -o -name '*token*' -o -name '*secret*' -o -name '*.key' -o -name 'node_modules' -o -name '.git' \) | head -20
    echo "请剔除后重试。"
    exit 1
  fi
fi

command -v pinme >/dev/null 2>&1 || { echo "错误：pinme CLI 未安装（npm install -g pinme）"; exit 1; }

echo "上传到 IPFS（长期在线）..."
pinme upload "$SRC" ${DOMAIN_ARGS[@]+"${DOMAIN_ARGS[@]}"}
