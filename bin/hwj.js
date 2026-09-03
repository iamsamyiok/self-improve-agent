#!/usr/bin/env node
// hwj 统一入口调度器 — tui / gui / run / install / uninstall
// 所有路径以仓库根定位（__dirname 推导），与调用者 cwd 无关：安装到 PATH 后任意目录可用。
// 用法：hwj [tui] [--ws 名称] | hwj gui | hwj run [选项] 提示词 | hwj install | hwj help
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PKG = require('../package.json');
const ROOT = path.join(__dirname, '..');
const HWJ_JS = path.join(ROOT, 'hwj', 'hwj.js');
const SERVER_JS = path.join(ROOT, 'server.js');
const PROBE_JS = path.join(ROOT, 'tools', 'probe.js');

// Ctrl+C 由子进程自行处理（TUI：中断任务/双击退出；run：直接终止），调度器不抢信号
process.on('SIGINT', () => {});

const HELP = [
  `hwj-agent ${PKG.version} — 双层 Agent 自迭代系统（统一入口）`,
  '',
  '用法：hwj-agent [命令] [参数]',
  '',
  '  hwj-agent              检测配置（未配置/无效则打开网页配置页），就绪后选 TUI 或 GUI',
  '  hwj-agent tui [--ws 名称] 终端交互界面（--ws 指定工作区）',
  '  hwj-agent gui          启动 Web 界面（自动挑端口 3788-3796；已在跑则直接开浏览器）',
  '  hwj-agent run [选项] 提示词 非交互执行单次任务，输出过程与结果（退出码 0/1）',
  '  hwj-agent evolve [--promote] [--cases N] 运行一次 Self-Improving Agent 实验闭环',
  '    --ws 名称            指定工作区（默认 default，与 tui/网页版共享会话）',
  '    -q, --quiet          只输出最终结果（适合脚本/管道调用）',
  '    提示词为 -           从 stdin 读取（echo 任务 | hwj-agent run -）',
  '  hwj-agent install      安装 hwj 短命令到 PATH（Windows: WindowsApps；macOS/Linux: ~/.local/bin）',
  '  hwj-agent uninstall    从 PATH 移除 hwj 短命令',
  '  hwj-agent version      显示版本',
  '  hwj-agent help         显示本帮助',
  '',
  '环境变量：DUAL_AGENT_MOCK=1 演示模式；DUAL_AGENT_PORT=gui 起始端口；',
  'DUAL_AGENT_DATA / DUAL_AGENT_WS_ROOT 数据与工作区根（测试隔离用）',
].join('\n');

function die(msg, code = 1) { process.stderr.write(`hwj: ${msg}\n`); process.exit(code); }

// 前台运行子进程（stdio 继承：TUI/raw mode/颜色全兼容），退出码透传
function runSync(file, args, opts = {}) {
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.error) die(r.error.message);
  if (r.status === null) process.exit(r.signal === 'SIGINT' ? 130 : 1); // Ctrl+C 终止子进程
  process.exit(r.status);
}

function cmdTui(rest) { runSync(HWJ_JS, rest); }

function openBrowser(url) {
  try {
    const [cmd, cargs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, cargs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); // 无浏览器/无 xdg-open 环境静默降级（异步 error 必须监听，否则进程崩溃）
  } catch { /* 打不开浏览器时用户可手动访问 URL */ }
}

// Web 版：挑空闲端口起服务（与 start.bat 同逻辑：free → 起服务；ours → 开浏览器复用）
function cmdGui() {
  const env = { ...process.env, NO_PROXY: 'localhost,127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
  const start = Number(process.env.DUAL_AGENT_PORT) || 3788;
  for (let p = start; p < start + 9; p++) {
    const free = spawnSync(process.execPath, [PROBE_JS, String(p), 'free'], { stdio: 'ignore' }).status === 0;
    if (free) {
      process.stdout.write(`正在启动 hwj Web 版（端口 ${p}，就绪后自动打开浏览器；关闭全部网页约 1 分钟后自动退出，Ctrl+C 立即停止）\n`);
      runSync(SERVER_JS, ['--port', String(p)], { env });
    }
    const ours = spawnSync(process.execPath, [PROBE_JS, String(p), 'ours'], { stdio: 'ignore' }).status === 0;
    if (ours) { openBrowser(`http://localhost:${p}/`); process.exit(0); }
  }
  die(`端口 ${start}-${start + 8} 均被其他程序占用（可用 DUAL_AGENT_PORT 指定起始端口）`);
}

function readStdin() {
  if (process.stdin.isTTY) die('hwj run 需要提示词参数，或用管道：echo 任务 | hwj run -', 2);
  try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; }
}

// 非交互单次任务：hwj run [--ws 名称] [-q] 提示词（提示词为 - 时读 stdin）
async function cmdEvolve(rest) {
  const evo = require('../lib/evolution');
  const promote = rest.includes('--promote');
  let n = 12;
  const i = rest.indexOf('--cases'); if (i >= 0 && rest[i + 1]) n = Number(rest[i + 1]) || n;
  process.stdout.write(`Self-Improving Loop：读取 benchmark → 生成假设 → candidate → A/B → evaluator → regression → ${promote ? 'promote' : '等待晋级'}\n`);
  try {
    const r = await evo.runEvolution({ promote, cases:n });
    process.stdout.write(JSON.stringify(r,null,2)+'\n');
    process.exit(r.ok && r.stage !== 'rejected' ? 0 : 1);
  } catch(e) { die(String(e.message||e)); }
}

function cmdRun(rest) {
  const pass = [];
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--ws') { const v = rest[++i]; if (!v) die('--ws 缺少参数', 2); pass.push('--ws', v); }
    else if (a === '--quiet' || a === '-q') pass.push('--quiet');
    else if (a === '--') { words.push(...rest.slice(i + 1)); break; }
    else words.push(a);
  }
  let prompt = words.join(' ').trim();
  if (prompt === '-') prompt = readStdin();
  if (!prompt) die('用法：hwj run [--ws 名称] [-q] 提示词（提示词为 - 时读 stdin）', 2);
  // 注入调用位置：用户在任意目录执行 run 时告知 Agent 实际目录（数据仍集中存安装目录，但任务可定位用户文件）
  const callerCwd = path.resolve(process.cwd());
  if (callerCwd.toLowerCase() !== ROOT.toLowerCase()) {
    prompt += `\n\n[调用上下文] 用户在目录 ${callerCwd} 下执行本命令；若任务涉及其目录中的文件，请用绝对路径访问该目录。`;
  }
  runSync(HWJ_JS, ['--script', prompt, ...pass]);
}

// ---------- PATH 安装 ----------
// Windows：WindowsApps（默认已在用户 PATH，用户可写，零注册表修改，写 shim 立即生效）
// macOS/Linux：~/.local/bin（systemd/user 默认 PATH；不在 PATH 时提示）
function shimPaths() {
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
    return { dir, file: path.join(dir, 'hwj.cmd') };
  }
  const dir = path.join(os.homedir(), '.local', 'bin');
  return { dir, file: path.join(dir, 'hwj') };
}

function cmdInstall(rest) {
  const dryRun = rest.includes('--dry-run');
  const { dir, file } = shimPaths();
  const content = process.platform === 'win32'
    ? `@echo off\r\nnode "${ROOT}\\bin\\hwj.js" %*\r\n`
    : `#!/bin/sh\nexec node "${ROOT}/bin/hwj.js" "$@"\n`;
  const onPath = (process.env.PATH || '').split(path.delimiter).some(p => p && p.toLowerCase() === dir.toLowerCase());
  if (dryRun) {
    process.stdout.write(`[dry-run] 将写入：${file}\n[dry-run] 内容：\n${content.replace(/^/gm, '  ')}`);
    process.stdout.write(onPath ? '[dry-run] 该目录已在 PATH 中，安装后立即可用\n' : '[dry-run] 注意：该目录当前不在 PATH 中\n');
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content); // 覆盖旧 shim：重复 install 幂等，仓库换目录后重跑即可
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o755); } catch { /* 权限忽略 */ } }
  process.stdout.write(`已安装：${file}\n`);
  process.stdout.write('现在可在任意目录使用：hwj / hwj tui / hwj gui / hwj run "任务"\n');
  if (!onPath) process.stdout.write(`注意：${dir} 不在 PATH 中——请将其加入 PATH 后重开终端使用\n`);
  else process.stdout.write(process.platform === 'win32' ? '（WindowsApps 已在 PATH，已打开的终端立即可用）\n' : '（重开终端或 hash -r 后生效）\n');
  process.stdout.write('仓库移动/升级到新目录后，请在新目录重跑 hwj install 更新指向\n');
}

function cmdUninstall() {
  const { file } = shimPaths();
  let removed = false;
  try { fs.unlinkSync(file); removed = true; } catch { /* 未安装 */ }
  process.stdout.write(removed ? `已卸载：${file}（仓库本体未动，双击 hwj.bat/start.bat 仍可用）\n` : '未检测到已安装的 hwj（无需卸载）\n');
}

// ---------- hwj.bat 双击交互辅助（内部子命令，不进 help） ----------
// 中文交互全部经 Node 输出：规避 cmd 在 chcp 65001 下按字节偏移重读 bat 时切进多字节字符的解析 bug
function cmdChoose() {
  process.stderr.write([
    '',
    '  ===============================================',
    '    hwj 终端智能体 — 选择使用方式',
    '  ===============================================',
    '   [1] 永久安装（推荐）  装入用户 PATH，之后任意目录可用 hwj 命令',
    '   [2] 临时使用           打开一个专用终端窗口，关窗即失效、不留任何文件',
    '   [3] 直接启动           本次运行终端智能体（不做任何安装）',
    ''
  ].join('\n') + '\n请选择 [1/2/3]，直接回车默认 1：');
  const answer = c => {
    c = String(c).trim();
    if (c === '1' || c === '2' || c === '3') process.stdout.write(c);
    else if (!c) process.stdout.write('1');
    else { process.stderr.write(`\n[hwj] 无效选择：${c}，请重新输入\n`); process.stdout.write('?'); }
  };
  if (!process.stdin.isTTY) { process.stdout.write('1'); return; } // 非交互（管道/受限环境）默认永久安装
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.once('data', answer);
}
function cmdTempHint() {
  process.stdout.write([
    '',
    '  hwj 临时会话已就绪（仅本窗口可用，关闭窗口即失效）：',
    '    hwj               终端智能体          hwj gui              Web 界面',
    '    hwj run "任务"    单次执行            hwj run -q "任务"    仅输出结果',
    '  可先 cd 到你的项目目录再使用；数据集中保存在安装目录（workspaces\\、.data\\）。',
    ''
  ].join('\n') + '\n');
}
function cmdTempNote() {
  process.stdout.write('[hwj] 已打开临时会话窗口：在那个窗口内任意目录可用 hwj 命令，关闭即完全失效。本窗口可以安全关闭。\n');
}

// ---------- 默认入口流程（v1.1.2）：检测配置 → 有效则选 TUI/GUI，无效/未配置则开网页配置页 ----------
// 数据目录与 core/server 同源：DUAL_AGENT_DATA 可覆盖（测试隔离）
function dataDir() { return process.env.DUAL_AGENT_DATA || path.join(ROOT, '.data'); }
function readInnerConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    const i = cfg && cfg.inner;
    return (i && typeof i === 'object') ? i : {};
  } catch { return {}; }
}
// API 有效性探测：GET {base_url}/models（OpenAI 兼容标准端点，几乎零开销）
// 200=有效；401/403=key 无效；404/405=端点可达且鉴权通过（部分兼容服务未实现 /models）按有效处理；网络错误=不可达
async function checkApiValid(inner) {
  const url = String(inner.base_url || '').replace(/\/+$/, '') + '/models';
  try {
    const res = await fetch(url, {
      headers: { authorization: 'Bearer ' + inner.api_key },
      signal: AbortSignal.timeout(8000)
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: `API Key 无效（HTTP ${res.status}）` };
    if (res.status >= 500) return { ok: false, reason: `服务端错误（HTTP ${res.status}）` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `无法连接 ${inner.base_url}（${String((e && e.message) || e).slice(0, 80)}）` };
  }
}
// 打开网页配置页：挑空闲端口起 server（detached，与本命令生命周期解耦），开浏览器；返回 url 或 null
function openConfigWeb() {
  const { spawn, spawnSync: ss } = require('child_process');
  const net = require('net');
  const tryPort = p => { try { return ss(process.execPath, ['-e', `const n=require('net');const s=n.createServer();s.once('error',()=>process.exit(1));s.once('listening',()=>process.exit(0));s.listen(${p},'127.0.0.1');`], { stdio: 'ignore' }).status === 0; } catch { return false; } };
  const start = Number(process.env.DUAL_AGENT_PORT) || 3788;
  for (let p = start; p < start + 9; p++) {
    if (!tryPort(p)) continue;
    const env = { ...process.env, NO_PROXY: 'localhost,127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
    spawn(process.execPath, [SERVER_JS, '--port', String(p)], { detached: true, stdio: 'ignore', env, cwd: ROOT }).unref();
    const url = `http://localhost:${p}/`;
    try {
      const [cmd, cargs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, cargs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } catch { /* 浏览器打不开时用户可手动访问 */ }
    return url;
  }
  return null;
}
// 终端问答（用后即关，让子进程接管 stdin）
function askOnce(q) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, a => { rl.close(); resolve(String(a || '').trim().toLowerCase()); });
  });
}

async function cmdDefault(rest) {
  const readline = require('readline');
  // MOCK 演示模式不做配置检测（离线可用）
  if (process.env.DUAL_AGENT_MOCK === '1') return await chooseAndRun(rest);
  let webUrl = null;
  for (;;) {
    const inner = readInnerConfig();
    const complete = !!(inner.base_url && inner.api_key && inner.model);
    if (!complete) {
      process.stdout.write('\n[hwj-agent] 尚未配置 API（Base URL / API Key / 模型名）\n');
    } else {
      process.stdout.write(`[hwj-agent] 检测 API 有效性：${inner.model} @ ${inner.base_url} ... `);
      const v = await checkApiValid(inner);
      process.stdout.write(v.ok ? '有效\n' : `无效（${v.reason}）\n`);
      if (v.ok) return await chooseAndRun(rest);
      process.stdout.write('[hwj-agent] 请检查 API 配置（Key 过期/地址错误/服务未启动都会导致检测失败）\n');
    }
    if (!webUrl) {
      webUrl = openConfigWeb();
      if (webUrl) process.stdout.write(`[hwj-agent] 配置页已打开：${webUrl}（右上角「设置」填写并保存）\n`);
      else process.stdout.write('[hwj-agent] 端口 3788-3796 被占用，无法打开配置页——可运行 hwj-agent gui 手动处理\n');
    }
    if (!process.stdin.isTTY) { process.stdout.write('[hwj-agent] 非交互环境：配置完成后重新运行 hwj-agent\n'); process.exit(1); }
    const a = await askOnce('完成配置并保存后按回车重新检测（t=跳过检测直接进终端 q=退出）：');
    if (a === 'q') process.exit(0);
    if (a === 't') return await chooseAndRun(rest);
    webUrl = null; // 下轮检测失败时重新拉起/复用配置页提示
  }
}

// 配置就绪后的界面选择：回车=TUI（默认），2=GUI
async function chooseAndRun(rest) {
  if (!process.stdin.isTTY) return cmdTui(rest); // 管道/受限环境默认 TUI
  const a = await askOnce('\n选择界面  [1] 终端 TUI（回车默认）  [2] 网页 GUI：');
  if (a === '2') return cmdGui();
  return cmdTui(rest);
}

// ---------- 路由 ----------
const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
  case undefined: case '': cmdDefault(rest).catch(e => die(e && e.message || e)); break;
  case 'tui': case 'terminal': cmdTui(rest); break;
  case 'gui': case 'web': cmdGui(); break;
  case 'run': cmdRun(rest); break;
  case 'evolve': cmdEvolve(rest); break;
  case 'install': cmdInstall(rest); break;
  case 'uninstall': cmdUninstall(); break;
  case '_choose': cmdChoose(); break;
  case '_temphint': cmdTempHint(); break;
  case '_tempnote': cmdTempNote(); break;
  case 'help': case '--help': case '-h': process.stdout.write(HELP + '\n'); break;
  case 'version': case '--version': case '-v': process.stdout.write(`hwj-agent ${PKG.version}\n`); break;
  default: die(`未知命令：${sub}（hwj-agent help 查看用法）`, 2);
}
