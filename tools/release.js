#!/usr/bin/env node
// 发布打包器 — 白名单导出 + 敏感数据自检（零依赖）
// 用法：node tools/release.js            打包到 dist/dual-agent-<version>.zip
//       node tools/release.js --check    仅做安全自检（不打包）
//       node tools/release.js --list     列出白名单清单
// 白名单机制：只有显式列出的文件/目录才进入 zip，将来新增的运行数据永远不会泄入发布包。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const VERSION = PKG.version;

// ---- 发布白名单（目录整体纳入）----
const INCLUDE = [
  'bin',            // hwj 统一入口调度器
  'channels',       // Qwen Code Channels 接入
  'docs',           // 设计文档（含 docs/specs）
  'hwj',            // 终端智能体（TUI + 引擎）
  'lib',            // 内核（inner/outer/plugins/approval/...）
  'plugins',        // 21 个原子插件
  'public',         // Web 前端
  'skills',         // 技能库（Agent Skills 开放标准兼容）
  'test',           // 冒烟测试（node test/hwj-smoke.js 全平台可跑）
  'tools',          // probe/release 等工具
  'server.js',
  'package.json',
  'README.md',
  'qwen-extension.json',
  'start.bat', 'start.sh', 'start.command',
  'demo.bat',
  'hwj.bat', 'hwj.command',
  'install.bat', 'uninstall.bat',
  'release.bat',
  '.gitignore'
];

// ---- 禁带清单（自检用：发现即中止，双保险）----
const FORBIDDEN = ['.data', 'workspaces', 'node_modules', '.pi', '.monkeycode', 'dist'];

function fileMust(rel) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) { console.error(`[release] 缺少白名单文件：${rel}`); process.exit(1); }
}

// 安全自检：白名单完整 + 敏感文件不在白名单 + 包内无 API key 模式
function safetyCheck() {
  let bad = 0;
  for (const rel of INCLUDE) fileMust(rel);
  for (const f of INCLUDE) {
    if (FORBIDDEN.some(x => f === x || f.startsWith(x + '/'))) {
      console.error(`[release] 白名单包含禁带路径：${f}`); bad++;
    }
  }
  // 内置配置文件不应携带真实 key（.data/config.json 在白名单外，此处防御性扫描 server/lib 硬编码）
  for (const f of ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map(x => `lib/${x}`)]) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/sk-[A-Za-z0-9]{20,}/.test(txt)) { console.error(`[release] ${f} 疑似硬编码 API key`); bad++; }
  }
  if (bad) process.exit(1);
  console.log('[release] 安全文检通过：白名单完整，无敏感数据');
}

// 构建暂存目录（白名单复制 → zip → 删暂存）
function buildStaging(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of INCLUDE) {
    const src = path.join(ROOT, rel);
    const dst = path.join(dir, rel);
    fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.endsWith('.DS_Store') });
  }
  // 打包元信息：版本与构建时间，方便用户核对
  fs.writeFileSync(path.join(dir, 'VERSION.txt'), `dual-agent ${VERSION}\n打包时间：${new Date().toISOString()}\n入口：install.bat（装入 PATH） / start.bat（Web 版） / hwj.bat（终端版） / demo.bat（免配置演示）\n`);
}

(async () => {
  const mode = process.argv[2] || '';
  if (mode === '--list') { console.log(INCLUDE.join('\n')); return; }

  safetyCheck();
  if (mode === '--check') return;

  const dist = path.join(ROOT, 'dist');
  const stage = path.join(dist, `dual-agent-${VERSION}`);
  const zip = path.join(dist, `dual-agent-${VERSION}.zip`);
  fs.rmSync(dist, { recursive: true, force: true });
  buildStaging(stage);

  // Windows 用 PowerShell Compress-Archive；Unix 用 zip 命令
  const zipDir = path.join(dist, 'dual-agent-' + VERSION);
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${JSON.stringify(path.join(zipDir, '*')).slice(1, -1)}' -DestinationPath '${JSON.stringify(zip).slice(1, -1)}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('sh', ['-c', `cd '${zipDir}' && zip -r -q '${zip}' .`], { stdio: 'inherit' });
  }

  // 复检产物：解包清单抽查（zip 内不应出现禁带路径与 config.json）
  const list = process.platform === 'win32'
    ? String(execFileSync('powershell', ['-NoProfile', '-Command',
        `Add-Type -A 'System.IO.Compression.FileSystem'; [IO.Compression.ZipFile]::OpenRead('${JSON.stringify(zip).slice(1, -1)}').Entries.FullName -join \"\`n\"`]).toString())
    : String(execFileSync('unzip', ['-l', zip])).toString();
  const leak = [/.data\//, /workspaces\//, /config\.json$/, /node_modules\//, /\.pi\//].filter(re => re.test(list));
  if (leak.length) { console.error(`[release] 产物泄漏检查失败：${leak.map(r => r.source).join(', ')}`); fs.rmSync(dist, { recursive: true, force: true }); process.exit(1); }

  fs.rmSync(stage, { recursive: true, force: true });
  const size = (fs.statSync(zip).size / 1024).toFixed(0);
  const entries = list.split('\n').filter(x => x.trim()).length;
  console.log(`[release] 产物：${path.relative(ROOT, zip)}（${size} KB，${entries} 项）`);
})();
