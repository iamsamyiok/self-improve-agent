#!/usr/bin/env bash
# Show 临时静态发布脚本（48 小时自动过期）
# 用法: bash deploy.sh <产物目录或文件...> <项目名> [--spa]
#   目录模式: deploy.sh ./dist my-site          —— 直接发布静态站点
#   下载页模式: 先把文件与生成的 index.html 放入临时目录，再整体发布
# 依赖: bash / tar / curl / node（仅用于解析响应 JSON）

set -euo pipefail

SHOW_API_URL="${SHOW_API_URL:-https://show.127.dev}"

usage() { echo "用法: bash deploy.sh <目录> <项目名> [--spa]"; exit 2; }
[ $# -ge 2 ] || usage

SRC="$1"; NAME="$2"; shift 2
MODE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --spa) MODE_ARGS+=("-F" "mode=spa"); shift ;;
    *) shift ;;
  esac
done

[ -d "$SRC" ] || { echo "错误：$SRC 不是目录（分享零散文件请先把它们与生成的 index.html 放入一个临时目录）"; exit 1; }
[ -f "$SRC/index.html" ] || echo "警告：目录根没有 index.html，部署后站点将 404（下载页模式必须先生成 index.html）"

# 限额：平台硬性 10MB 压缩包 / 100 文件；可用环境变量覆盖（测试注入小限额）
MAX_BYTES="${SHOW_MAX_BYTES:-$((10 * 1024 * 1024))}"
MAX_FILES="${SHOW_MAX_FILES:-100}"

# 文件数预检：超限直接拒绝，不打包不上传
FILE_COUNT=$(find "$SRC" -type f | wc -l)
if [ "$FILE_COUNT" -gt "$MAX_FILES" ]; then
  echo "错误：文件数 $FILE_COUNT 超过上限 $MAX_FILES，已中止发布。请精简文件后重试。"
  exit 1
fi

# 安全检查：敏感文件一票否决，防止把密钥/凭据发布到公网
if find "$SRC" \( -name '.env*' -o -name '*.pem' -o -name '*token*' -o -name '*secret*' -o -name '*.key' \) -type f | grep -q .; then
  echo "错误：目录中检测到疑似敏感文件（.env/密钥/token/secret），已中止。请剔除后重试。"
  find "$SRC" \( -name '.env*' -o -name '*.pem' -o -name '*token*' -o -name '*secret*' -o -name '*.key' \) -type f
  exit 1
fi

TMP_TGZ=$(mktemp /tmp/show-upload-XXXX.tar.gz)
trap 'rm -f "$TMP_TGZ"' EXIT

tar czf "$TMP_TGZ" -C "$SRC" .

# 体积预检：对压缩包实测（服务端限额即包大小），超限不上传
PKG_BYTES=$(wc -c < "$TMP_TGZ")
if [ "$PKG_BYTES" -gt "$MAX_BYTES" ]; then
  echo "错误：压缩包 $(du -h "$TMP_TGZ" | cut -f1) 超过体积上限（$MAX_BYTES 字节），已中止发布、不执行上传。"
  echo "建议：剔除大文件（视频/安装包/数据集），大文件改用官方直链、GitHub Releases 或 pinme 长期发布。"
  exit 1
fi

SIZE=$(du -h "$TMP_TGZ" | cut -f1)
echo "预检通过（$SIZE，$FILE_COUNT 个文件），上传到 $SHOW_API_URL ..."

RESP=$(curl -s --max-time 120 -X POST "$SHOW_API_URL/upload" \
  -F "file=@$TMP_TGZ" \
  -F "name=$NAME" \
  ${MODE_ARGS[@]+"${MODE_ARGS[@]}"}) || { echo "错误：上传失败（网络不可达或超时）"; exit 1; }

# 解析 JSON：成功输出 url / expiresAt / deploymentId，失败透出原始响应
echo "$RESP" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(s); } catch { console.log("响应非 JSON：" + s.slice(0, 500)); process.exit(1); }
  if (!j.url) { console.log("部署失败：" + JSON.stringify(j).slice(0, 500)); process.exit(1); }
  const exp = j.expiresAt ? new Date(j.expiresAt) : null;
  const expTxt = exp && !isNaN(exp) ? "\n过期时间: " + exp.toLocaleString("zh-CN", { hour12: false }) + "（48 小时后自动删除）" : "";
  console.log("部署成功\nURL: " + j.url + expTxt + "\n部署ID: " + (j.deploymentId || j.id || "未知"));
});
'
