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

# 安全检查：敏感文件一票否决，防止把密钥/凭据发布到公网
if find "$SRC" \( -name '.env*' -o -name '*.pem' -o -name '*token*' -o -name '*secret*' -o -name '*.key' \) -type f | grep -q .; then
  echo "错误：目录中检测到疑似敏感文件（.env/密钥/token/secret），已中止。请剔除后重试。"
  find "$SRC" \( -name '.env*' -o -name '*.pem' -o -name '*token*' -o -name '*secret*' -o -name '*.key' \) -type f
  exit 1
fi

TMP_TGZ=$(mktemp /tmp/show-upload-XXXX.tar.gz)
trap 'rm -f "$TMP_TGZ"' EXIT

tar czf "$TMP_TGZ" -C "$SRC" .

SIZE=$(du -h "$TMP_TGZ" | cut -f1)
echo "打包完成：$SRC -> $TMP_TGZ（$SIZE），上传到 $SHOW_API_URL ..."

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
