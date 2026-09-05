# HWJ Agent Android（远程壳）

手机端安装包。本 APK 是纯 WebView 远程壳：程序本体运行在你的云 Windows 上，经 Tailscale 虚拟局域网访问。APK 本身零业务逻辑，程序升级无需更新 APK。

> 旧版（1.x）为内嵌 Node 运行时方案（APK 里跑完整程序），已废弃，源码归档于 `legacy-node-src/`。

## 功能

- 首次启动：设置页填写云 Windows 服务地址（如 `http://100.x.y.z:3788`），保存于本机（SharedPreferences），之后启动直连
- 地址格式兼容：Tailscale IP、MagicDNS 名、Tailscale Serve 的 `https://xxx.ts.net`（可省略 `http://` 前缀自动补全）
- 连接失败时给出分类指引（地址错 / Tailscale 掉线 / 服务未启动），一键重试或改地址
- 网页右下角悬浮按钮：随时更改地址 / 刷新
- 返回键 = 网页后退；`window.open` 新标签（帮助页、发布页）自动转系统浏览器；文件下载落地后拉起分享；`<input type=file>` 上传正常拉起选择器

## 使用前提

1. 云 Windows 已部署程序（`node server.js`，端口 3788）并安装 Tailscale
2. 手机已安装 Tailscale APP 并登录同一账号（建议在系统设置中允许 Tailscale 后台运行 / 电池不限制）
3. 手机浏览器访问 Tailscale IP 确认可达后，即可使用本 APK

## 安装

1. 打开仓库 GitHub → Releases → 「Android APK（最新构建）」→ 下载 `HWJ-Agent-vX.Y.Z.apk`
2. 手机上点开安装（需允许「安装未知来源应用」）
3. 首次启动填写服务地址

**从旧版 1.x 升级**：新旧签名不同，需先卸载旧版再安装（旧版数据可丢弃——地址在云 Windows 上）。

## 签名与升级（GitHub Actions）

推送 `android/**` 或手动 `workflow_dispatch` 会自动构建，产物发布到固定 Release（tag `android`）。

- **已配置正式签名 Secrets**：产物用固定 keystore 签名，覆盖安装即可升级
- **未配置**：回退临时 debug 签名（Actions 日志有 warning），可安装可使用；配置 Secrets 后与已装版本签名不一致，需卸载重装一次

### 配置正式签名 Secrets（一次性，推荐）

仓库 GitHub 页 → Settings → Secrets and variables → Actions → New repository secret，依次添加 4 个：

| Secret 名称 | 值 |
|---|---|
| `MOBILE_KEYSTORE_B64` | keystore 文件的 base64 全文 |
| `MOBILE_KEYSTORE_PASSWORD` | keystore 密码 |
| `MOBILE_KEY_ALIAS` | `hwj-mobile` |
| `MOBILE_KEY_PASSWORD` | 同 keystore 密码 |

四项的具体值已存放在开发环境 `.data/hwj-mobile-secrets.txt`（不进 git），配置时复制粘贴即可。

## 本地构建（可选）

```bash
# 需本地 JDK 17 + Android SDK；一般用 GitHub Actions 即可
cd android && gradle assembleRelease
```

## 版本规则

- `versionName` / `versionCode` 在 `app/build.gradle` 管理；改动 APK 代码时 bump
- 程序本体（云 Windows 上的 server.js）版本与 APK 版本相互独立
