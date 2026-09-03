// @name intent
// @desc 意图闭环（v0.9.14）：任务前抽取意图契约（.intent.json），执行中每轮注记防遗忘，
//       交付前硬断言 + LLM judge 核验，发现缺口自动返修（上限 2 轮）
// 零依赖；仅多步任务启用（isMultiStepTask 闸门），简单任务零开销
//
// 病根（v0.9.12 之前实测）：长任务后段上下文预算折叠把任务原文埋进历史，交付漏项
// （要求 3 个文件只写 2 个、对比维度缺一个）。todo 治步骤执行，不治要求覆盖——
// 意图契约治的正是"要求覆盖"。
//
// 设计纪律（两条防线，来自既有教训）：
// 1. judge 只标具体可查的缺口（文件缺失/问题未答/要求的维度缺失），禁止风格判断——
//    验证器误报比没有验证更糟（v0.9.4 教训）
// 2. 返修轮计入总轮数预算控制（上限 2 轮），防完美主义死循环（v0.9.10 反向教训）

const { withRetry } = require('./llmRetry');

// ---------- JSON 解析容错 ----------
// 模型输出常带 ```json 围栏或前后解释文字；截取首个 { 到末个 } 之间再 parse
function parseLooseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fenced = s.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(fenced.slice(start, end + 1)); } catch { return null; }
}

// ---------- 单次流式文本调用（无工具循环） ----------
// 意图抽取与交付核验共用：复用 withRetry 秒级退避；流式解析与 chatInnerReal 同源逻辑的极简版
async function callLLMText(cfg, msgs, opts = {}) {
  const url = String(cfg.base_url || '').replace(/\/+$/, '') + '/chat/completions';
  return await withRetry(async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: msgs,
        stream: true,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {})
      })
    });
    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`意图/核验 API ${resp.status}：${txt.slice(0, 200) || '无响应体'}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let out = '';
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
        const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
        if (delta && typeof delta.content === 'string') out += delta.content;
      }
    }
    return out;
  }, { onEvent: opts.onEvent, label: opts.label || '意图' });
}

// ---------- 意图抽取 ----------
const INTENT_SCHEMA_HINT = `{"task":"一句话概述","goals":["目标，≤3条"],"deliverables":[{"path":"产出文件路径（相对于工作区根目录，不要包含工作区前缀），非文件交付物为 null","criterion":"该交付物的验收标准"}],"constraints":["约束条件"],"acceptance":["可客观核验的验收条款，≤5条"]}`;

function buildIntentPrompt(taskText) {
  return [
    '你是需求分析器。把下面的任务解析为结构化意图契约 JSON，规则：',
    '1) 只依据任务原文，禁止脑补任务没提的要求；',
    '2) deliverables 覆盖全部产出物（文件/答案/结论），path 是任务明示或可合理推断的文件路径，纯问答类为 null；',
    '3) path 格式要求：使用相对于工作区根目录的路径（如 report.md、docs/api.md），不要包含工作区前缀（如 workspaces/xxx/ 或绝对路径）；',
    '4) acceptance 每条必须可客观核验（存在性/内容包含/问题已答），禁止"质量好"类模糊条款；',
    '5) goals ≤3 条、acceptance ≤5 条，直接输出 JSON，无任何解释文字。',
    `输出格式：${INTENT_SCHEMA_HINT}`,
    '',
    '任务原文：',
    taskText
  ].join('\n');
}

// P0 修复：路径标准化——去除工作区前缀，统一为相对路径
function normalizePath(rawPath, wsDir) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (!p || p === 'null') return null;
  // 如果包含工作区前缀，去除
  if (wsDir && p.startsWith(wsDir)) {
    p = p.slice(wsDir.length);
    if (p.startsWith('/') || p.startsWith('\\')) p = p.slice(1);
  }
  // 如果是绝对路径，转为相对路径（相对于 cwd）
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    // 尝试从绝对路径中提取文件名部分
    const basename = require('path').basename(p);
    return basename.length > 1 ? basename : null;
  }
  return p.slice(0, 200) || null;
}

// 归一化 + 防御：字段缺失/类型错的条目剔除，超限截断
function normalizeIntent(raw, wsDir) {
  if (!raw || typeof raw !== 'object') return null;
  const strArr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 200)) : []);
  const deliverables = (Array.isArray(raw.deliverables) ? raw.deliverables : [])
    .filter(d => d && typeof d === 'object')
    .slice(0, 6)
    .map(d => ({
      path: normalizePath(d.path, wsDir),
      criterion: typeof d.criterion === 'string' ? d.criterion.trim().slice(0, 300) : ''
    }));
  const intent = {
    task: typeof raw.task === 'string' ? raw.task.trim().slice(0, 200) : '',
    goals: strArr(raw.goals).slice(0, 3),
    deliverables,
    constraints: strArr(raw.constraints).slice(0, 5),
    acceptance: strArr(raw.acceptance).slice(0, 5)
  };
  if (!intent.task && !intent.goals.length && !intent.deliverables.length && !intent.acceptance.length) return null;
  return intent;
}

// 抽取失败返回 null（优雅降级：任务照旧执行，意图闭环特性不构成硬依赖）
async function extractIntent(cfg, taskText, opts = {}) {
  try {
    const text = await callLLMText(cfg, [
      { role: 'system', content: '你是需求分析器，只输出 JSON。' },
      { role: 'user', content: buildIntentPrompt(taskText) }
    ], { maxTokens: 800, onEvent: opts.onEvent, label: '意图抽取' });
    const raw = parseLooseJson(text);
    return normalizeIntent(raw, opts.wsDir);
  } catch { return null; }
}

// ---------- 意图注记（每轮注入发送副本，落盘干净——复用 todoNote 模式） ----------
function formatIntentNote(intent) {
  if (!intent) return '';
  const lines = ['[意图契约] 任务交付要求（执行全程对照，交付前逐条自查）：'];
  if (intent.task) lines.push(`概述：${intent.task}`);
  for (const d of intent.deliverables) lines.push(`- 交付物：${d.path || '（非文件）'}${d.criterion ? `——${d.criterion}` : ''}`);
  for (const a of intent.acceptance) lines.push(`- 验收：${a}`);
  for (const c of intent.constraints) lines.push(`- 约束：${c}`);
  lines.push('注意：最近上下文可能被折叠，本注记是任务要求的权威来源；遗漏任何一条即交付不合格。');
  return lines.slice(0, 16).join('\n');
}

// ---------- 交付核验 ----------
// 硬断言：文件类交付物 → verify 插件规则（exists + json_valid）
function buildVerifyArgs(intent) {
  if (!intent) return [];
  return intent.deliverables
    .filter(d => d.path)
    .map(d => ({
      path: d.path,
      rules: [{ type: 'exists' }, ...(d.path.endsWith('.json') ? [{ type: 'json_valid' }] : [])]
    }));
}

// judge 提示：只标具体可查的缺口，禁止风格判断
function buildJudgePrompt(intent, finalAnswer, hardResults) {
  return [
    '你是交付核验裁判。对照意图契约逐条核验最终交付，输出 JSON：',
    '{"verdict":"PASS 或 GAPS","gaps":["缺口描述，仅当 verdict=GAPS"]}',
    '核验纪律：',
    '1) 只标具体可查的缺口：要求的文件不存在、明确的问题没有回答、任务要求的维度/条目缺失；',
    '2) 禁止风格与口味判断（措辞/详略/格式偏好不算缺口）；',
    '3) 硬断言已 FAIL 的项直接列入 gaps（无需重复判断）；',
    '4) 全部满足输出 PASS；拿不准的项按满足处理（验证器误报比漏报更有害）。',
    '',
    '意图契约：',
    JSON.stringify(intent, null, 1),
    '',
    '硬断言结果（框架判定）：',
    hardResults && hardResults.length ? hardResults.join('\n') : '（无文件类交付物）',
    '',
    '最终交付内容：',
    String(finalAnswer || '').slice(0, 6000)
  ].join('\n');
}

// 判定解析：垃圾输出按 PASS 处理（false-positive 缺口比 false-negative 更有害——返修烧轮数）
function parseVerdict(text) {
  const v = parseLooseJson(text);
  if (!v) return { verdict: 'PASS', gaps: [] };
  const gaps = (Array.isArray(v.gaps) ? v.gaps : [])
    .filter(g => typeof g === 'string' && g.trim())
    .map(g => g.trim().slice(0, 300))
    .slice(0, 6);
  if (v.verdict === 'GAPS' && gaps.length) return { verdict: 'GAPS', gaps };
  return { verdict: 'PASS', gaps: [] };
}

module.exports = { parseLooseJson, callLLMText, extractIntent, normalizeIntent, formatIntentNote, buildVerifyArgs, buildJudgePrompt, parseVerdict, normalizePath };
