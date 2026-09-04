#!/usr/bin/env node
// hwj 终端智能体 — dual-agent 内层 Agent 能力的终端封装（零依赖 TUI）
// 用法：node hwj/hwj.js [--ws <工作区>] [--script "消息"]（--script 为非交互批处理，e2e 用）
// 环境变量与网页版一致：DUAL_AGENT_MOCK=1 演示模式；DUAL_AGENT_DATA / DUAL_AGENT_WS_ROOT 测试隔离
const core = require('./core');
const commands = require('./commands');
const { createTui } = require('./tui');
const PKG = require('../package.json');

const args = process.argv.slice(2);
function argOf(flag) { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; }
const SCRIPT_MSG = argOf('--script');
const QUIET = args.includes('--quiet'); // hwj run -q 安静模式：仅最终结果→stdout，错误→stderr
const WS_ARG = argOf('--ws');
const INTERACTIVE = !SCRIPT_MSG && process.stdin.isTTY && process.stdout.isTTY;

const BANNER = [
  `⎡ hwj-agent v${PKG.version} — 双层 Agent 自迭代系统`,
  `⎣ 内层引擎 + 21 插件 · /help 查看命令 · Ctrl+C 中断任务（空闲时双击退出）`
];

function quit(code) { process.exit(code); }

// 安静模式 UI：过程全部静默，最终结果→stdout，错误→stderr（供 hwj run -q 管道/脚本使用）
function quietUi() {
  return {
    printUser() {}, beginTask() {}, endTask() {}, setReply() {}, toolCall() {}, toolResult() {},
    usage() {}, setMeta() {}, printInfo() {}, printPlain() {}, close() {},
    printAssistant: t => process.stdout.write(String(t == null ? '' : t) + '\n'),
    printError: t => process.stderr.write(String(t == null ? '' : t) + '\n')
  };
}

async function main() {
  core.getConfig(); // 触发目录创建
  const state = core.hwjState();
  const ws = WS_ARG || state.ws || 'default';
  const mode = state.mode || 'build';

  // ---------- 非交互批处理模式（e2e / 管道） ----------
  if (!INTERACTIVE) {
    if (!SCRIPT_MSG) {
      console.error('hwj 需要在终端（TTY）中交互运行；批量执行用 --script "消息"');
      quit(2);
    }
    const ui = QUIET ? quietUi() : createTui({ plain: true, ws, mode, version: PKG.version });
    const ctx = { ws, mode, ui, abort: () => false };
    ui.printUser(SCRIPT_MSG);
    ui.beginTask();
    try {
      const r = await core.runTask(SCRIPT_MSG, ctx);
      ui.endTask();
      if (r.ok && r.finalText) ui.printAssistant(r.finalText);
      else if (r.aborted) ui.printInfo('已中断');
      quit(0);
    } catch (e) {
      ui.endTask();
      ui.printError(String((e && e.message) || e));
      quit(1);
    }
    return;
  }

  // ---------- 交互 TUI 模式 ----------
  const ui = createTui({ ws, mode, version: PKG.version, model: core.getConfig().inner.model || '' });
  let busy = false;          // 任务执行中
  let exiting = false;
  let abortFlag = false;     // SIGINT 置位，runTask 的 callPlugin 边界消费
  const queue = [];          // 执行中排队的消息（≤5，对齐 server 语义）
  const QUEUE_MAX = 5;

  const cfg0 = core.getConfig();
  const unconfigured = process.env.DUAL_AGENT_MOCK !== '1' && !(cfg0.inner.base_url && cfg0.inner.api_key && cfg0.inner.model);

  // 首启横幅 + 会话恢复摘要
  BANNER.forEach(l => ui.printPlain(l));
  if (unconfigured) ui.printInfo('内层 API 未配置——先运行 /config 完成配置（与网页版共享）');
  const restored = core.loadSession(ws);
  if (restored.corrupted) ui.printInfo('检测到损坏的会话文件，已备份为 .bak 并重开');
  else if (restored.length) ui.printInfo(`已恢复会话（${restored.length} 条消息，/history 查看，/reset 清空）`);
  ui.printPlain(`工作区：${ws} · 模式：${mode} · DUAL_AGENT_MOCK=${process.env.DUAL_AGENT_MOCK === '1' ? '1（演示）' : '0'}`);

  const taskCtx = () => ({ ws: core.hwjState().ws || 'default', mode: core.hwjState().mode || 'build', ui, abort: () => abortFlag });

  async function drainQueue() {
    while (queue.length && !busy && !exiting) {
      const msg = queue.shift();
      ui.setMeta({ queueN: queue.length });
      await submit(msg);
    }
  }

  async function submit(line) {
    const text = String(line || '').trim();
    if (!text) { ui.refreshPrompt(); return; }
    if (commands.isCommand(text)) {
      const r = await commands.runCommand(text, {
        ui, ws: core.hwjState().ws,
        onModeChange: m => ui.setMeta({ mode: m }),
        onWorkspaceChange: w => { ui.setMeta({ ws: w }); },
        onReset: () => {}
      });
      if (r === 'exit') { exiting = true; ui.printInfo('会话已保存，再见'); ui.close(); quit(0); return; }
      ui.refreshPrompt();
      return;
    }
    if (busy) {
      if (queue.length >= QUEUE_MAX) { ui.printError(`排队已达上限（${QUEUE_MAX} 条），请等当前任务完成`); ui.refreshPrompt(); return; }
      queue.push(text);
      ui.setMeta({ queueN: queue.length });
      ui.printInfo(`任务执行中，本消息已排队（第 ${queue.length} 位），完成后自动执行`);
      ui.refreshPrompt();
      return;
    }
    busy = true; abortFlag = false;
    ui.printUser(text);
    ui.beginTask();
    const ctx = taskCtx();
    try {
      const r = await core.runTask(text, ctx);
      ui.endTask();
      if (r.aborted) ui.printInfo('已中断（已完成轮次已保留，可直接继续对话）');
      else if (r.ok && r.finalText) ui.printAssistant(r.finalText);
    } catch (e) {
      ui.endTask();
      ui.printError(String((e && e.message) || e));
    } finally {
      busy = false; abortFlag = false;
      ui.setMeta({ busy: '', queueN: queue.length });
      if (!exiting) { drainQueue().catch(() => {}); ui.refreshPrompt(); }
    }
  }

  ui.setHandlers({
    onLine: line => { submit(line).catch(e => ui.printError(String(e && e.message || e))); },
    onSigint: count => {
      if (busy) {
        if (!abortFlag) { abortFlag = true; ui.printInfo('正在中断（等待当前工具调用边界，已完成轮次将保留）…'); }
        return;
      }
      if (count >= 2) { exiting = true; ui.printInfo('会话已保存，再见'); ui.close(); quit(0); }
      else ui.printInfo('再按一次 Ctrl+C 退出');
    }
  });

  ui.start();
  // 未配置时引导配置（v1.1.1：网页配置优先——表单体验远好于终端逐项问答；终端向导降为备选）
  if (unconfigured) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(res => rl.question(q, a => res(String(a || '').trim().toLowerCase())));
    let ans = '';
    try { ans = await ask('内层 API 未配置。回车打开网页配置（推荐，浏览器填表单）；t=终端向导；n=跳过：'); }
    catch { /* 输入异常按跳过处理 */ }
    finally { rl.close(); }
    if (ans === 't') {
      await commands.runCommand('/config', { ui, ws, onModeChange: () => {}, onWorkspaceChange: () => {}, onReset: () => {} });
      ui.printInfo('配置完成，现在输入任务开始（/help 查看命令）');
    } else if (ans === 'n') {
      ui.printInfo('已跳过。随时 /config 终端向导，或退出后运行 hwj-agent gui 打开网页配置');
    } else {
      // 后台起 Web 服务 + 开浏览器（detached：TUI 退出不影响配置页；网页全关 60 秒后服务自动退出）
      const net = require('net');
      const tryPort = p => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '127.0.0.1'); });
      let port = 0;
      for (let p = Number(process.env.DUAL_AGENT_PORT) || 3788; p < (Number(process.env.DUAL_AGENT_PORT) || 3788) + 9; p++) {
        if (await tryPort(p)) { port = p; break; }
      }
      if (port) {
        const { spawn } = require('child_process');
        const env = { ...process.env, NO_PROXY: 'localhost,127.0.0.1', HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' };
        spawn(process.execPath, [require('path').join(__dirname, '..', 'server.js'), '--port', String(port)], { detached: true, stdio: 'ignore', env }).unref();
        const url = `http://localhost:${port}/`;
        try {
          const [cmd, cargs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
            : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
          spawn(cmd, cargs, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
        } catch { /* 打不开时用户可手动访问 */ }
        ui.printInfo(`配置页已打开：${url}（右上角「设置」填 Base URL / API Key / 模型名，保存即生效）`);
        ui.printInfo('完成后回到本终端直接输入任务即可（无需重启）。打不开浏览器就手动访问上面的地址');
      } else {
        ui.printInfo('端口 3788-3796 被占用，无法打开配置页。运行 /config 用终端向导配置');
      }
      ui.refreshPrompt();
    }
  }
}

main().catch(e => { console.error('[hwj] 启动失败:', e && (e.stack || e.message) || e); quit(1); });
