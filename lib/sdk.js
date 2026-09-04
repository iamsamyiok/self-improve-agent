// hwj-agent SDK 入口（v1.1.0）
// 两行代码用内层 Agent：
//   const { chat } = require('hwj-agent');
//   const answer = await chat({ baseUrl, apiKey, model, message: '你好' });
// 零依赖（仅 Node 内置模块），MOCK 模式（DUAL_AGENT_MOCK=1）可离线试用。
//
// API：
//   chat(opts) → Promise<string>            单轮问答（无工具，纯对话）
//     opts: { baseUrl, apiKey, model, message, system?, onEvent? }
//           三项 API 配置可省略——回落共享 .data/config.json（同 hwj/网页版）
//   run(opts) → Promise<{ok, finalText}>    单任务完整编排（注入/工具流/核验/归档，同 hwj run）
//     opts: { message, ws?, mode?, dataDir?, wsRoot?, pluginsDir?, onInfo?, abort? }
//   create(opts) → { chat, run }            预置配置的实例（opts 同上，可复用）
const path = require('path');
const fs = require('fs');

// ---------- 共享配置回落（与 hwj/网页版同一 .data/config.json） ----------
function sharedInnerCfg(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const i = cfg && cfg.inner;
    return (i && i.base_url && i.api_key && i.model) ? i : null;
  } catch { return null; }
}

function resolveCfg(opts, dataDir) {
  if (opts.baseUrl && opts.apiKey && opts.model) {
    return { base_url: opts.baseUrl, api_key: opts.apiKey, model: opts.model };
  }
  const sh = sharedInnerCfg(dataDir);
  if (sh) return sh;
  throw new Error('API 未配置：传入 { baseUrl, apiKey, model }，或先在 hwj/网页版完成配置（共享 .data/config.json）');
}

// ---------- chat：单轮问答 ----------
async function chat(opts = {}) {
  const inner = require('./inner');
  const plugins = require('./plugins');
  const dataDir = opts.dataDir || path.join(__dirname, '..', '.data');
  const cfg = resolveCfg(opts, dataDir);
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
  messages.push({ role: 'user', content: String(opts.message || '') });
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  // 单轮问答默认不带工具（纯对话）；tools: true 开启全插件工具流
  const tools = opts.tools === true ? plugins.toolDefs() : [];
  const callPlugin = async (name, args) => plugins.runPlugin(name, args, { cwd: process.cwd(), dataDir });
  return inner.chatInner(cfg, messages, tools, callPlugin, onEvent, { tag: 'sdk-chat' });
}

// ---------- run：单任务完整编排（复用 hwj core 的 runTask） ----------
async function run(opts = {}) {
  // core 模块顶层常量（DATA_DIR/WS_ROOT/PLUGINS_DIR）在 require 时读 env——先设再加载
  if (opts.dataDir) process.env.DUAL_AGENT_DATA = opts.dataDir;
  if (opts.wsRoot) process.env.DUAL_AGENT_WS_ROOT = opts.wsRoot;
  if (opts.pluginsDir) process.env.DUAL_AGENT_PLUGINS_DIR = opts.pluginsDir;
  const core = require('../hwj/core');
  const onInfo = typeof opts.onInfo === 'function' ? opts.onInfo : () => {};
  // 静默 UI 代理：吸收 TUI 全部绘制调用，框架事件转发给 onInfo
  const ui = new Proxy({}, {
    get: (t, prop) => {
      if (prop === 'recentTools') return () => [];
      return (...a) => {
        const s = String(a[0] == null ? '' : a[0]);
        if (s) onInfo(s);
      };
    }
  });
  const abort = typeof opts.abort === 'function' ? opts.abort : () => false;
  return core.runTask(String(opts.message || ''), {
    ws: opts.ws || 'default',
    mode: opts.mode === 'plan' ? 'plan' : 'build',
    ui,
    abort
  });
}

// ---------- create：预置配置实例 ----------
function create(preset = {}) {
  return {
    chat: (opts = {}) => chat({ ...preset, ...opts }),
    run: (opts = {}) => run({ ...preset, ...opts })
  };
}

async function evolve(opts = {}) {
  if (opts.dataDir) process.env.DUAL_AGENT_DATA = opts.dataDir;
  if (opts.wsRoot) process.env.DUAL_AGENT_WS_ROOT = opts.wsRoot;
  if (opts.pluginsDir) process.env.DUAL_AGENT_PLUGINS_DIR = opts.pluginsDir;
  const evolution = require('./evolution');
  return evolution.runEvolution(opts);
}

module.exports = { chat, run, evolve, create };
