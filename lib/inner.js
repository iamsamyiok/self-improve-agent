// 内层引擎：OpenAI 兼容 API（/chat/completions 流式）+ 插件工具调用循环
// DUAL_AGENT_MOCK=1 时走本地脚本化假 LLM（无需真实 API 即可演示全流程）
const vm = require('vm');
const path = require('path');
const { withRetry, RetryableError, makeHttpError, LlmTimeout } = require('./llmRetry');
const MAX_ROUNDS = 24; // 工具调用轮数上限（长文分段+偶发重试下 12 不够；死循环保护仍在）

// ---------- tool_calls.arguments 净化 ----------
// 部分模型（尤其小参数量）流式产出的 arguments 是非法 JSON：键无引号、单引号、尾逗号、截断。
// 原样回填 messages 会让下一轮 API 直接 400（arguments must be valid JSON）且无法自纠。
// parseToolArgs：{ ok, text }；合法原样 → 以 { 开头的尝试 vm 沙箱宽松解析 → 失败降级 '{}'，
// 由框架的必填参数校验给 LLM 明确的重试提示形成自愈闭环。
function parseToolArgs(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: true, text: '{}' };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, text: s };
    return { ok: true, text: '{}' }; // 合法 JSON 但非对象（数字/数组等）→ 降级
  } catch { /* 继续修复 */ }
  if (!s.startsWith('{')) return { ok: false, text: '{}' }; // 仅接受对象字面量形态，防代码注入进沙箱
  try {
    const val = vm.runInNewContext(`(${s})`, Object.freeze({}), { timeout: 200 });
    if (val && typeof val === 'object' && !Array.isArray(val)) return { ok: true, text: JSON.stringify(val) };
  } catch { /* 修复失败 */ }
  return { ok: false, text: '{}' };
}
function sanitizeToolArguments(raw) {
  return parseToolArgs(raw).text;
}

// ---------- 流拆分重组（真实 API 兼容性修复，2026-08 agnes-2.5-flash 实测） ----------
// 部分 OpenAI 兼容 API 会把同一次调用的超大 arguments 间歇性拆到多个 index 流
// （如 index 0 = 完整前半 JSON、index 1 = 后半片段），违反流式协议：逐桶 JSON 均不完整，
// 简单净化会把两次都降级 '{}'，模型重试再被拆，循环耗尽轮数上限。
// 重组策略（三遍）：
//   1. 逐桶解析，合法桶直接通过
//   2. 无 id/name 的残桶（纯 arguments 延续）并入前一桶原始串重试（正序/反序各一次）
//   3. 仍存在坏桶且有多个桶时：全部按序拼接为单次调用兜底（模型把一次调用拆成多个有 id 的流）
function reassembleCalls(callsMap) {
  const list = [...callsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, name: c.name, raw: c.args }));
  for (const c of list) c.parsed = parseToolArgs(c.raw);
  const out = [];
  for (const c of list) {
    if (c.parsed.ok) { out.push(c); continue; }
    const prev = out[out.length - 1];
    if (prev && !c.id && !c.name) {
      const m1 = parseToolArgs(prev.raw + c.raw);
      if (m1.ok) { out[out.length - 1] = { id: prev.id, name: prev.name, raw: prev.raw + c.raw, parsed: m1 }; continue; }
      const m2 = parseToolArgs(c.raw + prev.raw);
      if (m2.ok) { out[out.length - 1] = { id: prev.id, name: prev.name, raw: c.raw + prev.raw, parsed: m2 }; continue; }
    }
    out.push(c); // 暂存坏桶（第三遍可能整体救回）
  }
  if (out.length > 1 && out.some(c => !c.parsed.ok)) {
    const all = parseToolArgs(list.map(c => c.raw).join(''));
    if (all.ok) {
      const f = list.find(c => c.id || c.name) || list[0];
      return [{ id: f.id || '', name: f.name || '', args: all.text }];
    }
  }
  // 空参数标记：raw 完全为空 = API 流式传输丢失 arguments（agnes 实测单调用/多调用尾部均出现），
  // 与"截断"区分——前者原样重试即可，后者需缩短内容
  return out.map(c => ({
    id: c.id, name: c.name,
    args: c.parsed.ok ? c.parsed.text : '{}',
    emptyRaw: !c.raw, // true = 参数在传输中整体丢失
    truncatedRaw: !!c.raw && !c.parsed.ok // true = 参数传输中被截断（收到不完整 JSON 片段）
  }));
}

// ---------- Hermes <tool_call> 文本格式兜底解析 ----------
// 病根：部分 OpenAI 兼容模型（硅基流动 Qwen 系等）不走原生 delta.tool_calls 通道，
// 把工具调用以 Hermes/Qwen chat-template 文本吐在 content 里。实测三种形态：
//   ① 标准：<tool_call>\n{"name":"search","arguments":{"query":"..."}}\n</tool_call>
//   ② python-kwargs：<tool_call>search(query="x", language="zh")（无 JSON）
//   ③ 残缺：连发多个空 <tool_call>（无内容、无闭合）夹杂有效块
// 解析成功则转换为标准 calls 走既有执行链路；解析不出任何有效调用则原样当普通文本。
function parseKwargsArgs(s) {
  // key="v" / key='v' / key=123 / key=true / key=null，逗号分割（引号内逗号不切）
  const out = {};
  let key = '', val = '', inD = null, hasEq = false;
  const flush = () => {
    if (!key) return;
    let v = val.trim();
    if (hasEq) {
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (v === 'null') v = null;
      else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    } else v = true; // 布尔简写 key
    out[key.trim()] = v;
    key = ''; val = ''; hasEq = false;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inD) { val += ch; if (ch === inD) inD = null; continue; }
    if (ch === '"' || ch === "'") { inD = ch; val += ch; continue; }
    if (ch === '=') { hasEq = true; continue; }
    if (ch === ',') { flush(); continue; }
    if (hasEq) val += ch; else key += ch;
  }
  flush();
  return out;
}

function parseHermesToolCalls(text) {
  const res = { calls: [], cleaned: text };
  if (typeof text !== 'string' || !text.includes('<tool_call>')) return res;
  // 以 <tool_call> 为界切片段：每段取标记后到下一个 <tool_call> / </tool_call> / 末尾
  const parts = text.split('<tool_call>');
  const calls = [];
  const kept = []; // 非工具调用的剩余文本（保序拼接为 cleaned）
  kept.push(parts[0]);
  for (let i = 1; i < parts.length; i++) {
    let seg = parts[i];
    const closeIdx = seg.indexOf('</tool_call>');
    let body = closeIdx >= 0 ? seg.slice(0, closeIdx) : seg;
    const rest = closeIdx >= 0 ? seg.slice(closeIdx + '</tool_call>'.length) : '';
    if (rest.trim()) kept.push(rest);
    body = body.trim();
    if (!body) continue; // 残缺空块（③）：跳过
    let name = null, args = {};
    // 形态①：JSON 对象
    if (body.startsWith('{')) {
      try {
        const j = JSON.parse(body);
        if (j && typeof j.name === 'string') {
          name = j.name;
          args = j.arguments || j.parameters || {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        }
      } catch { /* 非 JSON，落 kwargs */ }
    }
    // 形态②：name(k=v, ...) / name(...)
    if (!name) {
      const m = body.match(/^([A-Za-z_][\w-]*)\s*\(([\s\S]*)\)\s*$/);
      if (m) { name = m[1]; args = parseKwargsArgs(m[2]); }
    }
    // 形态②'：裸 name(k=v,...) 无右括号（截断）——补齐尝试
    if (!name) {
      const m = body.match(/^([A-Za-z_][\w-]*)\s*\(([\s\S]+)$/);
      if (m) { name = m[1]; args = parseKwargsArgs(m[2].replace(/\)\s*$/, '')); }
    }
    if (name) calls.push({ name, args });
  }
  res.calls = calls;
  res.cleaned = kept.join('').trim();
  return res;
}

// ---------- 配对安全裁剪（v0.9.12 P0-1） ----------
// 病根：persistInnerMessages 用 slice(-60) 截历史，切点落在 assistant.tool_calls 与其
// tool 结果之间时落盘会话含悬空配对——下次调 API 直接 400（tool message must follow
// tool_calls）且无法自愈。长会话必然碰到。
// 裁剪策略：从目标切点向前回退到"安全边界"（system 之后的首条 user，或上一组完整
// 配对的结束处），保证首条消息不是悬空 tool、每条 tool 都有对应的 tool_calls 宿主。
function pairSafeTail(messages, maxKeep) {
  if (!Array.isArray(messages) || messages.length <= maxKeep) return messages;
  let cut = messages.length - maxKeep;
  // 回退：切点必须是安全边界——首条 role ∈ {user, system}，且前一条不是带 tool_calls 的
  // assistant（否则把 tool_calls 宿主裁掉，其 tool 结果变悬空）
  while (cut < messages.length) {
    const m = messages[cut];
    const prev = cut > 0 ? messages[cut - 1] : null;
    const safeRole = m && (m.role === 'user' || m.role === 'system');
    const prevClean = !prev || !(prev.role === 'assistant' && prev.tool_calls);
    if (safeRole && prevClean) break;
    cut += 1;
  }
  if (cut >= messages.length) return messages.slice(-Math.min(maxKeep, messages.length));
  const tail = messages.slice(cut);
  // 防御性清洗：剔除悬空 tool（宿主 assistant 在被裁掉的 prefix 里）
  const seen = new Set();
  for (const m of tail) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) if (c && c.id) seen.add(c.id);
    }
  }
  return tail.filter(m => !(m.role === 'tool' && !seen.has(m.tool_call_id)));
}

// ---------- 真实链路 ----------
// 止损阈值：同一轮内同一插件连续失败达到该次数后，本轮后续该插件调用直接跳过，
// 防止模型在失败上无限重试（实测 agnes 空参风暴：单轮 100+ 次失败占满轮数上限）。
const STALL_LIMIT = 3;

// 止损判定：同插件本轮连续失败 STALL_LIMIT 次且从未成功 → 跳过（防失败风暴占满轮数）
function shouldStall(roundFails, name) {
  const s = roundFails.get(name);
  return !!s && s.n >= STALL_LIMIT && !s.ok;
}
function recordFail(roundFails, name, ok) {
  if (ok) { roundFails.delete(name); return; }
  const s = roundFails.get(name) || { n: 0, ok: false };
  s.n += 1;
  roundFails.set(name, s);
}

// ---------- 上下文预算管理 ----------
// 病根：messages 无限增长（read 大文件/插件全量结果），最终撞 token 上限 → API 400 且无法自愈。
// 策略：发 API 前构造压缩副本（落盘的 inner-messages.json 保持完整）：
// - 预算默认 60000 tokens（DUAL_AGENT_CTX_BUDGET 可调），超出时从最旧的 tool 结果开始压缩
// - tool content 压缩为 头300+尾100+折叠标记（保留关键入参回执与结尾指示）
// - 绝不删除条目：assistant.tool_calls 与 tool 结果必须配对（OpenAI 协议），删了直接 400
// - system 永不压缩；最近 K 轮（4 轮）tool 结果保持全文
// - 压缩策略科学：token 预算（非字符预算），CJK 1char≈1token，ASCII 4chars≈1token
function estimateChars(messages) {
  let n = 0;
  for (const m of messages) {
    n += (m.content && typeof m.content === 'string') ? m.content.length : 0;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

// estimateTokensV2：科学 token 估算（OpenAI 官方建议 1token ≈ 4chars 英文，1char ≈ 1token CJK）
// 改进：对 tool 消息额外计入 JSON 结构开销（key 名、括号等约 10% overhead）
function estimateTokensV2(str) {
  const s = String(str || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  const base = cjk + Math.ceil((s.length - cjk) / 4);
  // JSON 结构开销（键名、逗号、括号）约 8-12%，取 10% 安全余量
  return Math.ceil(base * 1.1);
}

// estimateMessagesTokens：批量估算整组消息的 token 数（含结构开销）
function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    if (m.role === 'system') {
      total += estimateTokensV2('[system] ') + estimateTokensV2(m.content || '');
    } else if (m.role === 'user') {
      total += estimateTokensV2('[user] ') + estimateTokensV2(m.content || '');
    } else if (m.role === 'assistant') {
      total += estimateTokensV2('[assistant] ');
      if (m.content) total += estimateTokensV2(m.content);
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          total += estimateTokensV2(JSON.stringify(tc));
        }
      }
    } else if (m.role === 'tool') {
      total += estimateTokensV2('[tool] ') + estimateTokensV2(m.content || '');
    }
  }
  return total;
}

// ---------- token 计量 ----------
// 病根（v0.9.0 修复）：全链路对真实 token 用量零采集——请求不带 stream_options，
// 解析器遇 choices 空帧（协议中携带 usage 的末帧）直接 continue，API 返回的真实用量被丢弃。
// 模型被问"用了多少 token"时只能按自己输出的文字量脑补（千级），而计费口径是每轮
// 全量 prompt 重发（系统提示+技能清单+全部工具结果，多轮循环累计轻松几十万）——差两个数量级。
// 修复四件套：① 请求带 stream_options.include_usage（网关 400 不识别时自动降级）
// ② 捕获 usage 末帧（choices 可为空）③ 每轮累计并发 usage 事件 ④ 无 usage 网关用
// estimateTokens 估算兜底（est 标记）。模型每轮还会收到注入发送副本的计量注记（落盘干净）。
function estimateTokens(str) {
  const s = String(str || '');
  let cjk = 0;
  for (const ch of s) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk++;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

// 计量注记：注入发送副本末尾（messages 落盘保持干净），让模型每轮握有真实数字
function usageNoteMsg(last, totals, sendChars) {
  const lines = ['[token 计量] 以下为本会话 API 真实用量（或高质量估算），回答 token 用量类问题必须引用这些数字，禁止自行估算：'];
  if (last) lines.push(`- 上一轮 API 调用：prompt ${last.prompt} tok${last.cached ? `（其中缓存命中 ${last.cached}）` : ''} + 输出 ${last.completion} tok`);
  lines.push(`- 会话累计（API 计费口径）：${totals.calls} 次调用，prompt ${totals.prompt} tok + 输出 ${totals.completion} tok${totals.cached ? `（缓存命中 ${totals.cached}）` : ''}`);
  lines.push(`- 注意计费口径每轮 prompt 全量重发，累计值远大于净上下文体积（本轮发送约 ${sendChars} 字符）。`);
  lines.push('详细历史可用 usage 插件查询（action=get 本区累计 / action=history 按会话分组）。');
  return { role: 'system', content: lines.join('\n') };
}

// 多步任务启发式检测：编号步骤 / 顺序连接词 / 显式步骤计数。
// 病根（v0.9.3）：todo 插件长期闲置——模型（agnes-2.5-flash 实测）无视 system 提示里的
// 程序性指令（memory.search/skill.list/todo 建清单全跳过），但对紧邻任务文本遵循度高。
// server 侧检测后注入 user 消息尾部，不依赖模型自觉。
function isMultiStepTask(msg) {
  const s = String(msg || '');
  if (!s) return false;
  let steps = 0;
  // 显式编号：1. / ① / 第一步 / 步骤1 等出现 ≥2 处
  steps += (s.match(/(?:^|\s)(?:\d+[.、)）]|[(（]\d+[)）]|[①②③④⑤⑥⑦⑧⑨⑩])/g) || []).length;
  steps += (s.match(/第[一二三四五六七八九十\d]+步/g) || []).length;
  // 顺序连接词（口语多步标志）
  const conjunctives = (s.match(/然后|接着|其次|再(?!次?报)|最后|依次|逐个|逐条|按顺序/g) || []).length;
  // "然后+产出动作"强多步信号：单个连接词但明确指向第二个产出动作（实测两步任务高频且同样需要黑板/核验保护）
  if (/然后[^。；]{0,40}(生成|创建|写入|汇总|更新|输出|导出)/.test(s)) return true;
  return steps >= 2 || conjunctives >= 2 || (steps >= 1 && conjunctives >= 1);
}

// 长文创作任务检测（v0.9.17 病根：模型以"万字超单次输出"为由直接拒绝——它没想到
// 分章分段用 write 工具流可以完成）。检测字数指标 + 长文体裁，server 注入创作纪律
function isLongFormTask(msg) {
  const s = String(msg || '');
  if (!s) return false;
  // 字数指标：X 字 / X 千字 / X 万字 / X+-字（含"上万/过万"）
  const cnt = /(\d+(?:\.\d+)?)\s*(?:万|千)?\s*字/.test(s) || /[上超]万字|过万/.test(s);
  // 长文体裁（无字数指标的长篇创作也算：小说/长篇/深度报告等自带长文属性）
  const genre = /万字|长篇小说|长篇(?:小说|故事|报告|文章)|短篇小说|中篇小说|小说|剧本|论文|深度(?:报告|分析|调研报告)|系列文章|连载/.test(s);
  return cnt || genre;
}

// 拒绝后催促检测（v0.9.17 病根：模型拒绝万字任务 → 用户"请你搞定" → 模型被历史
// 记忆锚定彻底跑偏到旧任务）。上一条 assistant 回复含拒绝话术 + 新消息短促催促 →
// 需要对齐注入："搞定"指的是刚才被拒绝的那件事，必须尝试工具流执行
const REFUSAL_RE = /(无法|不能|没法|抱歉|超出.*(能力|限制|范围)|不适合|建议.*(直接使用|分解|使用专业)|超出单次输出)/;
const NUDGE_RE = /^(请)?(你)?(一定要|必须|给我)?(搞定|做|写|继续|开始|执行|完成|整|弄|来|上)(了)?([吧啊!?。！？]|)$/;
// P10 改进：NUDGE_RE 过于宽松，"做吧"单字也会命中；增加上下文校验——新消息短促且上一轮 assistant 含拒绝话术才算
function isRefusalNudge(lastAssistantText, newMsg) {
  const s = String(newMsg || '').trim();
  if (!s || s.length > 12) return false;
  if (!NUDGE_RE.test(s)) return false;
  // P10：严格上下文校验——只有当上一轮 assistant 回复含拒绝话术时才触发
  // 否则"做吧""写"等正常指令会被误判为对齐注入
  const lastText = String(lastAssistantText || '');
  if (!REFUSAL_RE.test(lastText)) return false;
  return true;
}

// 滚动摘要折叠（P1-3）：多轮任务后期，发送副本只保留任务原文/用户插话 + 最近窗口轮次，
// 早期轮次折叠为机械摘要（每轮工具调用 + 结果要点）——上下文从"超限后被动压缩"升级为
// "轮数驱动主动折叠"，后期每轮 prompt 大小有界，LLM 延迟与费用随轮数平稳。
// 落盘历史不变（仅发送副本折叠，与 budgetMessages 同哲学）；折叠不丢细节——process 过程文件有全程
const ROLLUP_ROUNDS = Math.max(4, Number(process.env.DUAL_AGENT_ROLLUP_ROUNDS) || 8); // 超过该轮数启用折叠
const ROLLUP_KEEP = 4; // 最近保留窗口轮数（不折叠）

function rollupMessages(messages) {
  // 以 assistant 消息为轮锚点
  const asstIdx = [];
  messages.forEach((m, i) => { if (m.role === 'assistant') asstIdx.push(i); });
  if (asstIdx.length <= ROLLUP_ROUNDS) return null; // 未达折叠阈值
  const keepFrom = asstIdx[asstIdx.length - ROLLUP_KEEP]; // 最近窗口起点（assistant 锚点，保证 tool 配对完整）
  if (keepFrom <= 0) return null;
  const out = [];
  const sumLines = [];
  let round = 0;
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (i < keepFrom && m.role !== 'user') {
      if (m.role === 'assistant') {
        round++;
        const names = (m.tool_calls || []).map(tc => tc && tc.function && tc.function.name).filter(Boolean);
        if (names.length) sumLines.push(`- 轮${round}：调用 ${names.join('、')}`);
        else if (typeof m.content === 'string' && m.content.trim()) sumLines.push(`- 轮${round}：${m.content.trim().slice(0, 80).replace(/\s+/g, ' ')}`);
        i++;
        // 收编同轮 tool 结果（取首行要点挂到该轮摘要行尾）
        while (i < messages.length && i < keepFrom && messages[i].role === 'tool') {
          const head = String(messages[i].content || '').trim().slice(0, 80).replace(/\s+/g, ' ');
          if (head && sumLines.length) sumLines[sumLines.length - 1] += ` → ${head}`;
          i++;
        }
      } else { i++; } // 折叠区其他 role（罕见）跳过
      continue;
    }
    out.push(m);
    i++;
  }
  if (!sumLines.length) return null;
  // 摘要插入位置：第一条 user（任务原文）之后；摘要以 user 口径注入，配对安全（不与 tool 悬空）
  const summary = { role: 'user', content: `[上下文折叠·早期执行摘要] 以下是最早 ${round} 轮的机械摘要（每轮工具与结果要点，完整细节见工作区 process 过程文件，需要时用 read 查看）：\n${sumLines.join('\n')}` };
  const fu = out.findIndex(m => m.role === 'user');
  if (fu >= 0) out.splice(fu + 1, 0, summary); else out.unshift(summary);
  return out;
}

function budgetMessages(messages) {
  // 先滚动折叠（轮数驱动），再走 token 预算压缩（对保留窗口仍生效）
  const rolled = rollupMessages(messages);
  if (rolled) messages = rolled;
  // 上下文预算对齐 Agnes 窗口（lib/limits.js）：默认窗口 80%（419,430 tokens，预留 20%
  // 给输出与误差）；此前 60000 过于保守，长任务频繁压缩丢失关键依据
  const limits = require('./limits');
  const budget = Number(process.env.DUAL_AGENT_CTX_BUDGET) || limits.INPUT_BUDGET_TOKENS;
  const tokens = estimateMessagesTokens(messages);
  if (tokens <= budget) return messages;
  // 最近 6 个 tool 结果索引保持全文（P6 改进：从 4 扩大到 6，长任务关键决策依据不丢失）
  const toolIdx = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
  const keepFull = new Set(toolIdx.slice(-6));
  // P6 改进：verify 写入类操作结果始终保留全文（框架判定结果不可压缩）
  messages.forEach((m, i) => {
    if (m.role === 'tool' && m.content && /PASS|FAIL|写入成功|已创建|已更新|断言成功|文件存在|line_count/.test(m.content)) {
      keepFull.add(i);
    }
  });
  const out = messages.map((m, i) => {
    if (m.role !== 'tool' || keepFull.has(i) || typeof m.content !== 'string') return m;
    if (m.content.length <= 500) return m; // 短结果无压缩价值
    const head = m.content.slice(0, 300);
    const tail = m.content.slice(-100);
    return { ...m, content: `${head}\n…［上下文预算：此结果已折叠 ${(m.content.length - 400)} 字符，完整内容见工作区 process 过程文件］…\n${tail}` };
  });
  return out;
}


// 只读插件集合：一轮多个同类调用可并行执行（写类操作必须串行防冲突）
const READONLY_PLUGINS = new Set(['read', 'search', 'fetch', 'usage', 'memory', 'todo', 'skill', 'verify']);

async function chatInnerReal(cfg, messages, tools, callPlugin, onEvent, opts = {}) {
  const url = cfg.base_url.replace(/\/+$/, '') + '/chat/completions';
  // 跨轮失败计数（止损用）：同一插件连续失败（期间无成功）累计达 STALL_LIMIT 次即跳过，
  // 覆盖「每轮 1 次失败 × N 轮」的慢风暴（实测 agnes 丢参常见此形态）
  const failStreak = new Map();
  // 传输层失败计数：参数整体丢失/截断累计。第 1 次提示原样重试；连续 ≥2 次说明该通道
  // 无法可靠传输大参数，强制提示改分段写入（实测：模型原样重试大参数 → 永远截断 → 死循环）
  const transLoss = { n: 0 };
  // token 计量：会话累计 + 网关不识别 stream_options 的降级标记
  const usageTotals = { calls: 0, prompt: 0, completion: 0, cached: 0 };
  let noUsageOpt = false;
  let lastUsage = null;
  // 子智能体支持：opts.maxRounds 子级轮数上限；opts.todoNote 每轮取最新清单状态的函数
  // 自动续航（v0.9.12 P0-3）：opts.shouldContinue() 回调 + opts.totalRounds 总预算（默认 3×maxRounds）。
  // 病根：撞 24 轮上限后停下等用户人肉发"继续"泵——长任务无法自走。修复：段上限撞顶且
  // shouldContinue()（server 实现读 todo 未完成项）为 true 时自动注入续航消息续跑下一段，
  // 直到总预算耗尽或任务收敛。每段续航发 info 事件告知前端
  const maxRounds = opts.maxRounds || MAX_ROUNDS;
  const totalRounds = opts.totalRounds || (opts.shouldContinue ? maxRounds * 3 : maxRounds);

  let round = 0;
  let segEnd = Math.min(maxRounds, totalRounds); // 当前段的结束边界（不含）
  while (round < totalRounds) {
    // 轮开始事件（P0-1）：前端进度指示（"第 N 轮执行中"）
    if (typeof opts.onRoundStart === 'function') { try { opts.onRoundStart(round + 1, totalRounds); } catch { /* 进度事件失败不阻断 */ } }
    // 发送副本构造（每轮一次）：上下文预算压缩 + 计量注记 + 动态清单注记（仅发送，落盘干净）
    const budgeted = budgetMessages(messages);
    const sendTokens = estimateMessagesTokens(budgeted);
    const notes = [];
    // P4/P8：上下文体积预警（v0.9.22）：sendTokens > 80% 预算时注入精简注记
    // 让模型提前感知上下文压力，主动精简后续输出（如减少冗余重复、避免过长 tool 结果）
    if (sendTokens > (Number(process.env.DUAL_AGENT_CTX_BUDGET) || 60000) * 0.8) {
      const pct = Math.round(sendTokens / (Number(process.env.DUAL_AGENT_CTX_BUDGET) || 60000) * 100);
      notes.push({ role: 'system', content: `[上下文预警] 当前发送上下文约 ${sendTokens} tokens（占预算 ${pct}%），已接近压缩阈值。后续输出请保持简洁，避免冗余重复；关键结论优先于细节铺陈。` });
    }
    if (usageTotals.calls > 0) notes.push(usageNoteMsg(lastUsage, usageTotals, sendTokens));
    if (typeof opts.todoNote === 'function') {
      const tn = opts.todoNote();
      if (tn) notes.push({ role: 'system', content: tn });
    }
    // 黑板注记（黑板模式）：工作区 task-state.md 的最新内容每轮注入发送副本——
    // 长任务上下文折叠后模型仍握有浓缩权威状态，无需翻历史找线索（落盘干净）
    if (typeof opts.blackboardNote === 'function') {
      const bn = opts.blackboardNote();
      if (bn) notes.push({ role: 'system', content: bn });
    }
    // 意图契约注记（v0.9.14）：每轮把交付要求注入发送副本——长任务后段上下文折叠
    // 把任务原文埋进历史时，模型仍握有权威要求来源（落盘干净，复用 todoNote 模式）
    if (typeof opts.intentNote === 'function') {
      const it = opts.intentNote();
      if (it) notes.push({ role: 'system', content: it });
    }
    // 预取注记（P0-2）：记忆/归档预取与首轮 LLM 并行，完成后从此处注入——
    // 首轮 notes 构造时预取未完成返回空（首轮不注入），第二轮起带上（预取 2s 内基本已完成）
    if (typeof opts.prefetchNote === 'function') {
      const pf = opts.prefetchNote();
      if (pf) notes.push({ role: 'system', content: pf });
    }
    // 轮数预算注记（v0.9.10 病根：真实调研撞 24 轮上限零结论）：剩余 ≤25% 时强制
    // 注入收敛指令——基于已有证据总结（标注不确定项），禁止开启新探索线。防"探索
    // 完美主义"：引擎质量低时模型永远想找更准的数字，永不收敛，撞顶连部分结论都丢
    const roundsLeft = segEnd - round;
    if (roundsLeft <= Math.max(2, Math.ceil(maxRounds * 0.25))) {
      const total = totalRounds > maxRounds ? `（总预算 ${totalRounds} 轮，已用 ${round}）` : '';
      notes.push({ role: 'system', content: `[轮数预算] 本段仅剩 ${roundsLeft} 轮${total}。立即收敛：基于已掌握的证据输出最终结论——已有的数字/事实直接用，缺失部分明确标注"未找到可靠数据"与不确定度。禁止开启新探索线或继续找更精确的数字。` });
    }
    const sendMsgs = notes.length ? [...budgeted, ...notes] : budgeted;
    // 单次尝试：建连 + 完整读流（AbortController 超时防挂起流卡死任务）。整体包进 withRetry：
    // 限流（429/402/5xx/特征词）与网络抖动按 3s→9s→27s→81s 指数退避（±50% 抖动）自动重试；
    // 重试时重置本轮累积（assistant 消息尚未入 messages，text 事件为快照式，重复安全）；
    // 429 带 Retry-After 时优先服务端指示
    const { content, calls, usage } = await withRetry(async () => {
      const to = new LlmTimeout('内层');
      try {
      const payload = { model: cfg.model, messages: sendMsgs, tools: tools.length ? tools : undefined, stream: true };
      // 配对比较：进化实验 worker 路径温度默认 0——baseline 与 candidate 在同一 case 上
      // 的输出差异只反映 mutation 的效果，把执行随机性从 A/B 结论里剥掉
      if (process.env.DUAL_AGENT_EVOLUTION_WORKER === '1' && payload.temperature === undefined) {
        const t = Number(process.env.DUAL_AGENT_EVOLUTION_LLM_TEMPERATURE);
        if (Number.isFinite(t)) payload.temperature = t;
      }
      if (!noUsageOpt) payload.stream_options = { include_usage: true }; // 真实 token 计量（老网关 400 时自动降级）
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.api_key}` },
        body: JSON.stringify(payload),
        signal: to.signal
      });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => '');
        // 部分老网关不识别 stream_options 直接 400：置降级标记后按可重试错误重跑（下次不带该参数）
        if (resp.status === 400 && !noUsageOpt && /stream_options/i.test(txt)) {
          noUsageOpt = true;
          throw new RetryableError('网关不识别 stream_options，去除该参数重试');
        }
        throw makeHttpError(resp.status, txt, '内层', resp.headers);
      }

      // SSE 流式解析：拼接 content 与 tool_calls 增量；捕获 usage 末帧（choices 可为空数组）
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const content = { text: '' };
      const calls = new Map(); // index -> {id, name, args}
      let usageFrame = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.usage && typeof ev.usage === 'object') usageFrame = ev.usage; // 先于 delta 判定：usage 末帧 choices 为空
          const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            content.text += delta.content;
            // 增量推送（P0-1）：只发增量片段，避免全量快照的 O(n²) SSE 流量；
            // 每轮 LLM 完成后仍有 text 快照（下方）供前端校准一致性
            onEvent({ type: 'delta', text: delta.content });
          }
          for (const tc of delta.tool_calls || []) {
            const c = calls.get(tc.index) || { id: '', name: '', args: '' };
            if (tc.id) c.id = tc.id;
            if (tc.function && tc.function.name) c.name += tc.function.name;
            if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
            calls.set(tc.index, c);
          }
        }
      }
      to.clear();
      return { content, calls, usage: usageFrame };
      } catch (e) { throw to.settle(e); }
    }, { onEvent, label: '内层 LLM', ...(opts.retryBaseMs !== undefined ? { baseMs: opts.retryBaseMs } : {}) });

    // token 计量落账：优先 API 真实返回；无 usage 网关用字符折算估算（est 标记）
    let est = false;
    let roundUsage = usage;
    if (!roundUsage) {
      est = true;
      roundUsage = {
        prompt_tokens: estimateTokensV2(JSON.stringify(sendMsgs)) + (tools.length ? estimateTokensV2(JSON.stringify(tools)) : 0),
        completion_tokens: estimateTokensV2(content.text) + [...calls.values()].reduce((n, c) => n + estimateTokensV2(c.args), 0)
      };
    }
    usageTotals.calls += 1;
    usageTotals.prompt += roundUsage.prompt_tokens || 0;
    usageTotals.completion += roundUsage.completion_tokens || 0;
    const cached = (roundUsage.prompt_tokens_details && roundUsage.prompt_tokens_details.cached_tokens) || 0;
    usageTotals.cached += cached;
    lastUsage = { prompt: roundUsage.prompt_tokens || 0, completion: roundUsage.completion_tokens || 0, cached };
    onEvent({ type: 'usage', est, totals: { ...usageTotals }, last: { ...lastUsage }, tag: opts.tag || '' });

    // 无原生 tool_calls：尝试 Hermes <tool_call> 文本兜底（部分模型不走原生通道）
    if (!calls.size) {
      const hermes = parseHermesToolCalls(content.text);
      if (hermes.calls.length) {
        hermes.calls.forEach((c, i) => calls.set(i, {
          id: `hermes-${Date.now()}-${i}`,
          name: c.name,
          args: JSON.stringify(c.args),
          emptyRaw: false, truncatedRaw: false // 文本已整体到手，无传输丢失语义
        }));
        content.text = hermes.cleaned; // 剥离标记后的剩余文本（通常为空）
        onEvent({ type: 'text', text: content.text });
      }
    }

    // 轮末校准快照（P0-1）：增量 delta 之上发一次全量，前端覆盖对齐，消除累积偏差
    onEvent({ type: 'text', text: content.text });

    // 无工具调用：本轮即最终回答
    if (!calls.size) {
      messages.push({ role: 'assistant', content: content.text });
      return content.text;
    }

    // 有工具调用：重组拆分流（兼容把超大 arguments 拆到多个 index 的 API）并净化
    // DUAL_AGENT_DEBUG_TC=1 时把原始分桶落盘（诊断流式协议异常用）
    if (process.env.DUAL_AGENT_DEBUG_TC === '1' && calls.size) {
      try {
        const fs = require('fs');
        const dump = [...calls.entries()].sort((a, b) => a[0] - b[0])
          .map(([i, c]) => `index=${i} id=${JSON.stringify(c.id)} name=${JSON.stringify(c.name)} argsLen=${c.args.length}\n  head=${JSON.stringify(c.args.slice(0, 120))}\n  tail=${JSON.stringify(c.args.slice(-120))}`).join('\n');
        fs.appendFileSync(path.join(process.env.DUAL_AGENT_DATA || path.join(__dirname, '..', '.data'), 'tc-debug.log'), `--- ${new Date().toISOString()} ---\n${dump}\n`);
      } catch { /* ignore */ }
    }
    const toolCalls = reassembleCalls(calls);
    messages.push({
      role: 'assistant',
      content: content.text || null,
      tool_calls: toolCalls.map(c => ({ id: c.id || `call-${c.name}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }))
    });

    // 单次工具调用执行（止损判定 + 传输层失败 + 执行 + 事件），messages.push 由外层按序处理
    const execOne = async (c) => {
      const cid = c.id || `call-${c.name}`;
      const state = failStreak.get(c.name) || { n: 0, ok: false };
      if (shouldStall(failStreak, c.name)) {
        const msg = `插件 ${c.name} 已连续失败 ${state.n} 次，判定当前调用方式不可行，停止执行 ${c.name} 调用。` +
          `请换一种方式完成目标：检查参数是否完整、改用其他插件（write/read/edit/bash 换一种组合）、或分小步重试。`;
        onEvent({ type: 'tool_result', plugin: c.name, ok: false, result: msg, ms: 0 });
        return { id: cid, result: msg, ok: false };
      }
      let args = {};
      try { args = JSON.parse(c.args || '{}'); } catch { /* 保持空对象 */ }
      onEvent({ type: 'tool_call', plugin: c.name, args });
      const t0 = Date.now();
      // 传输层失败（API 流式 bug）：跳过插件执行，直接给分层重试提示。
      // 截断型（truncatedRaw）与整体丢失（emptyRaw）一律不执行——带着残缺参数执行
      // 只会报"缺少必填参数"，误导模型以为是自己参数写错（实测死循环主因）。
      let result;
      if (c.emptyRaw || (c.truncatedRaw && !Object.keys(args).length)) {
        transLoss.n += 1;
        result = transLoss.n < 2
          ? `插件 ${c.name} 调用被拒绝：本次调用的 arguments 在 API 流式传输中${c.emptyRaw ? '整体丢失' : `被截断（仅收到不完整片段，非内容过长所致）`}。请原样重试同样的调用，无需缩短或修改内容。`
          : `插件 ${c.name} 调用被拒绝：参数已连续 ${transLoss.n} 次在 API 传输中丢失/截断，该通道无法可靠传输大参数，禁止再原样重试大调用。` +
            `立即改用分段模式完成写入：1) 首次 write(path=文件名, content=第一段, 每段 ≤1500 字符)；` +
            `2) 后续每段 write(path=同一路径, content=下一段, append=true)；` +
            `3) 用 read(path, tail=10) 确认衔接。段与段内容绝不能重叠或跳行。`;
      } else {
        result = await callPlugin(c.name, args);
        if (!/^插件.*?(加载失败|执行出错|调用被拒绝)/.test(result)) transLoss.n = Math.max(0, transLoss.n - 1); // 连续2次成功才清零（防间歇性截断误判恢复）
      }
      const ms = Date.now() - t0;
      const ok = !/^插件.*?(加载失败|执行出错|调用被拒绝)/.test(result);
      onEvent({ type: 'tool_result', plugin: c.name, ok, result, ms }); // 全量结果：过程文件需要完整内容，前端自行截断显示
      recordFail(failStreak, c.name, ok);
      return { id: cid, result, ok };
    };

    // 只读批次并行（v0.9.5）：一轮 N 个只读调用并发执行，耗时 = max 而非 sum；
    // 含写类操作（write/edit/bash/subagent）保持串行防同文件竞态
    const allReadOnly = toolCalls.length > 1 && toolCalls.every(c => READONLY_PLUGINS.has(c.name));
    let execResults;
    if (allReadOnly) {
      execResults = await Promise.all(toolCalls.map(c => execOne(c)));
    } else {
      execResults = [];
      for (const c of toolCalls) execResults.push(await execOne(c));
    }
    for (const r of execResults) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
    }
    // 每轮落盘回调（v0.9.12 P0-2）：工具结果入列后立即通知外层持久化，
    // 进程崩溃/重启时进行中任务的执行历史不丢（此前仅任务首尾落盘，中途全在内存）
    if (typeof opts.onRound === 'function') {
      try { opts.onRound(round, messages); } catch { /* 回调失败不阻断循环 */ }
    }
    round += 1;
    // 段边界：撞段上限且任务未完 → 自动续航（注入 user 消息续跑下一段）；总预算耗尽才真正停下
    if (round >= segEnd && round < totalRounds && typeof opts.shouldContinue === 'function') {
      let goOn = false;
      try { goOn = !!opts.shouldContinue(); } catch { /* 判定失败视为不续航 */ }
      if (goOn) {
        onEvent({ type: 'info', text: `已达单段 ${maxRounds} 轮上限，任务清单仍有未完成项——自动续航（已用 ${round}/${totalRounds} 轮）` });
        messages.push({ role: 'user', content: '[自动续航] 上一段工具循环已达轮数上限，但任务清单仍有未完成项。请对照 [任务清单] 注记继续执行剩余步骤（已完成的不必重做），保持每完成一步 todo.toggle 勾选。若你判断任务实际已无法继续，明确说明原因并停下。' });
        segEnd = Math.min(round + maxRounds, totalRounds);
        continue;
      }
      break; // shouldContinue 判定任务已收敛（无未完成项）→ 段上限即停，禁止空转耗预算
    }
  }
  const tail = `已达到工具调用轮数上限（累计 ${round}/${totalRounds}），强制结束本轮。可以发"继续"让我接着完成。`;
  messages.push({ role: 'assistant', content: tail });
  onEvent({ type: 'text', text: tail });
  return tail;
}

// ---------- 演示模式：脚本化假 LLM ----------
// 行为：先 bash echo 探路 → write 写一个演示文件 → 输出总结（覆盖工具循环+日志+建议触发）
async function chatInnerMock(cfg, messages, tools, callPlugin, onEvent) {
  const plan = [
    { plugin: 'bash', args: { command: 'echo 内层演示：当前目录 && pwd' } },
    { plugin: 'write', args: { path: 'demo-note.txt', content: '这是内层 Agent 通过 write 插件创建的演示文件。\n' } }
  ];
  let acc = '';
  for (const step of plan) {
    onEvent({ type: 'tool_call', plugin: step.plugin, args: step.args });
    const t0 = Date.now();
    const result = await callPlugin(step.plugin, step.args);
    onEvent({ type: 'tool_result', plugin: step.plugin, ok: true, result, ms: Date.now() - t0 });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `m-${step.plugin}`, type: 'function', function: { name: step.plugin, arguments: JSON.stringify(step.args) } }] });
    messages.push({ role: 'tool', tool_call_id: `m-${step.plugin}`, content: result });
  }
  const finalText = '演示模式执行完成：已通过 bash 查看工作目录，并用 write 插件创建了 demo-note.txt。真实模式下我会根据你的任务自主选择插件组合完成。';
  acc = finalText;
  onEvent({ type: 'text', text: acc });
  onEvent({ type: 'usage', est: true, totals: { calls: 2, prompt: 2100, completion: 180, cached: 0 }, last: { prompt: 1400, completion: 90, cached: 0 } });
  messages.push({ role: 'assistant', content: finalText });
  return finalText;
}

function chatInner(cfg, messages, tools, callPlugin, onEvent, opts = {}) {
  return process.env.DUAL_AGENT_MOCK === '1'
    ? chatInnerMock(cfg, messages, tools, callPlugin, onEvent)
    : chatInnerReal(cfg, messages, tools, callPlugin, onEvent, opts);
}

module.exports = { chatInner, chatInnerReal, MAX_ROUNDS, READONLY_PLUGINS, sanitizeToolArguments, parseToolArgs, reassembleCalls, shouldStall, recordFail, STALL_LIMIT, budgetMessages, rollupMessages, estimateChars, estimateTokens, estimateTokensV2, estimateMessagesTokens, usageNoteMsg, isMultiStepTask, isLongFormTask, isRefusalNudge, pairSafeTail, parseHermesToolCalls, parseKwargsArgs };
