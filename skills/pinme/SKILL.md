---
name: pinme
description: 长期静态网站发布（IPFS 持久存续，永不过期）。当用户提到 pinme、长期发布、永久发布、IPFS 发布、需要网站长期在线时使用。与 show 技能（48 小时临时分享）互补：短期随手分享用 show，长期在线用 pinme。
---

# PinMe 长期发布

零配置部署：把静态文件上传到 IPFS，获得长期在线的公开 URL（内容寻址，永不过期）。进阶还支持全栈项目（React+Vite + Cloudflare Worker + D1 数据库），详见文末。

## 与 show 技能的分工

| | show | pinme |
|---|------|-------|
| 存活 | 48 小时自动过期 | IPFS 长期在线 |
| 体积 | 总包 ≤10 MB | 总量/单文件 ≤500 MB |
| 文件数 | ≤100 | 无限制 |
| 适用 | 临时预览、随手分享 | 正式交付、长期访问 |

用户没说清时要先确认：「临时看一下」用 show，「长期访问」用 pinme。

**体积限额实测**（CLI v2.0.12 源码 `FILE_SIZE_LIMIT`/`DIRECTORY_SIZE_LIMIT`，README 的 100MB 单文件说法已过时）：单文件 ≤500MB，目录总量 ≤500MB，环境变量 `PINME_MAX_TOTAL_BYTES`/`PINME_MAX_FILE_BYTES` 可覆盖。

## 前置条件（本机通常已就绪）

1. CLI 已安装：`pinme --version` 有输出即就绪；未装则 `npm install -g pinme@latest`
2. 认证已配置：本机已执行过 `pinme set-appkey <AppKey>`（密钥存在 pinme 本地配置，不入 git）。若提示未登录，向用户索取 AppKey 后执行一次即可，密钥不得写入任何仓库文件

## 发布流程（静态站点/文件）

**推荐直接用发布脚本**（内置体积/文件数/敏感文件三重预检，超限拒绝发布，避免无效上传）：

```bash
bash <技能目录>/deploy.sh <产物目录或文件> [--domain <名称>] [--dns]
```

手动上传时按以下流程：

**1. 确定上传目录**（按优先级）：

1. `dist/` — Vite / Vue / React 构建产物
2. `build/` — Create React App
3. `out/` — Next.js 静态导出
4. `public/` — 纯静态文件

单文件也可直接上传（`pinme upload ./doc.pdf`）。

**2. 发布前安全检查（一票否决）**：待发布目录绝不能包含敏感文件——`.env`、密钥/凭据、`*token*`、`*secret*`、`.git/`、`node_modules/`、源码目录（`src/`）、数据库文件、用户数据。IPFS 内容公开且被永久缓存，泄露无法撤回（rm 仅解除你的 pin，缓存仍可能存在）。

**3. 上传**：

```bash
pinme upload <目录或文件>
```

**4. 返回 URL**：把 PinMe 输出的最终 URL 完整交给用户——**含全部 hash 字符，绝不截断**。URL 优先级：DNS 域名 > PinMe 子域名 > 短链 > 预览链接。

## 常用命令

```bash
pinme list / pinme ls -l 5   # 上传历史
pinme rm <hash>              # 删除上传（解除 pin）
pinme upload ./dist --domain my-site  # 绑定子域名（需钱包余额）
pinme export <CID>           # 导出 CAR 文件
pinme logout                 # 退出登录
```

## 全栈项目（进阶，按需使用）

`pinme create <name>` 生成 React+Vite 前端 + Cloudflare Worker 后端 + D1 SQLite 数据库模板；改模板代码后 `pinme save` 一键全量部署（后端独立地址 `https://{name}.pinme.pro`，前端 API 自动指向）。仅改后端/前端/数据库之一时可用 `pinme update-worker / update-web / update-db` 增量更新。Worker 内禁用 Node 专有模块、本地文件系统与子进程；SQL 一律参数化（`.bind()`），禁止字符串拼接；密码必须经 bcrypt/scrypt/Argon2 哈希。细节参考上游文档：https://github.com/glitternetwork/pinme
