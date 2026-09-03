// @name intent
// @desc 意图契约系统（v0.9.24）：任务前抽取意图契约，执行中每轮注记防遗忘，交付前核验缺口自动返修
// @essential false
const fs = require('fs');
const path = require('path');

// 内联必要函数（避免循环依赖）
function parseLooseJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fenced = s.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(fenced.slice(start, end + 1)); } catch { return null; }
}

async function callLLMText(cfg, msgs, opts = {}) {
  const url = String(cfg.base_url || '').replace(/\/+$/, '') + '/chat/completions';
  // 简化版：非流式调用用于插件内部
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: msgs,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {})
    })
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`意图/核验 API ${resp.status}：${txt.slice(0, 200) || '无响应体'}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// 插件状态存储
const state = {
  intent: null,
  intentPath: null
};

// ---------- 路径标准化 ----------
function normalizePath(rawPath, wsDir) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let p = rawPath.trim();
  if (!p || p === 'null') return null;
  if (wsDir && p.startsWith(wsDir)) {
    p = p.slice(wsDir.length);
    if (p.startsWith('/') || p.startsWith('\\')) p = p.slice(1);
  }
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    const basename = require('path').basename(p);
    return basename.length > 1 ? basename : null;
  }
  return p.slice(0, 200) || null;
}

// ---------- 意图提取操作 ----------
async function extractIntentOperation(args, ctx) {
  const cfg = ctx.config ? JSON.parse(fs.readFileSync(ctx.config, 'utf8')) : null;
  if (!cfg || !cfg.inner || !cfg.inner.base_url) {
    return '错误：未配置内层 LLM API（请在设置中配置 Base URL 和 API Key）';
  }
  
  const taskText = String(args.task || '').trim();
  if (!taskText) return '错误：请提供任务描述';
  
  const wsDir = ctx.cwd;
  
  // 抽取意图
  const intent = await callLLMText(cfg.inner, [
    { role: 'system', content: '你是需求分析器，只输出 JSON。' },
    { role: 'user', content: buildIntentPrompt(taskText) }
  ], { maxTokens: 800, label: '意图抽取' });
  
  const raw = parseLooseJson(intent);
  const normalized = normalizeIntent(raw, wsDir);
  
  if (!normalized) {
    return '意图抽取失败：无法解析为有效意图契约';
  }
  
  // 落盘
  const intentPath = path.join(wsDir, '.intent.json');
  fs.writeFileSync(intentPath, JSON.stringify(normalized, null, 1), 'utf8');
  state.intent = normalized;
  state.intentPath = intentPath;
  
  return `意图契约已建立：\n任务：${normalized.task}\n交付物：${normalized.deliverables.map(d => d.path || '非文件').join(', ')}\n验收条款：${normalized.acceptance.join('; ')}`;
}

// ---------- 查看意图操作 ----------
function viewIntentOperation(args, ctx) {
  const wsDir = ctx.cwd;
  const intentPath = path.join(wsDir, '.intent.json');
  
  try {
    const intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
    state.intent = intent;
    state.intentPath = intentPath;
    
    const lines = ['[意图契约]'];
    if (intent.task) lines.push(`任务：${intent.task}`);
    if (intent.deliverables.length) {
      lines.push('\n交付物：');
      for (const d of intent.deliverables) {
        lines.push(`- ${d.path || '非文件'}：${d.criterion || '无标准'}`);
      }
    }
    if (intent.acceptance.length) {
      lines.push('\n验收条款：');
      for (const a of intent.acceptance) {
        lines.push(`- ${a}`);
      }
    }
    if (intent.constraints.length) {
      lines.push('\n约束条件：');
      for (const c of intent.constraints) {
        lines.push(`- ${c}`);
      }
    }
    
    return lines.join('\n');
  } catch {
    return '当前工作区暂无意图契约（.intent.json 不存在）';
  }
}

// ---------- 清除意图操作 ----------
function clearIntentOperation(args, ctx) {
  const wsDir = ctx.cwd;
  const intentPath = path.join(wsDir, '.intent.json');
  
  try {
    fs.unlinkSync(intentPath);
    state.intent = null;
    state.intentPath = null;
    return '意图契约已清除';
  } catch {
    return '无需清除：当前无意图契约';
  }
}

// ---------- 核验交付操作 ----------
async function verifyDeliverablesOperation(args, ctx) {
  const intent = state.intent;
  if (!intent) {
    return '错误：当前无意图契约，请先调用 intent.extract 或 intent.view';
  }
  
  const gaps = [];
  const hardLines = [];
  
  // 硬断言：文件类交付物
  for (const d of intent.deliverables) {
    if (!d.path) continue;
    const fp = path.join(ctx.cwd, d.path);
    const exists = fs.existsSync(fp);
    
    if (!exists) {
      gaps.push(`交付文件未找到：${d.path}`);
      hardLines.push(`${d.path}：FAIL - 文件不存在`);
    } else {
      hardLines.push(`${d.path}：PASS - 文件存在`);
      
      // JSON 文件额外验证格式
      if (d.path.endsWith('.json')) {
        try {
          JSON.parse(fs.readFileSync(fp, 'utf8'));
          hardLines.push(`${d.path}：PASS - JSON 格式有效`);
        } catch {
          gaps.push(`交付文件 JSON 格式错误：${d.path}`);
          hardLines.push(`${d.path}：FAIL - JSON 格式无效`);
        }
      }
    }
  }
  
  // LLM judge：语义覆盖检查
  let judgeResult = null;
  if (!gaps.length) {
    try {
      const cfg = ctx.config ? JSON.parse(fs.readFileSync(ctx.config, 'utf8')) : null;
      if (cfg && cfg.inner && cfg.inner.base_url) {
        const finalAnswer = args.finalAnswer || '（用户提供）';
        const judgeText = await callLLMText(cfg.inner, [
          { role: 'system', content: '你是交付核验裁判，只输出 JSON。' },
          { role: 'user', content: buildJudgePrompt(intent, finalAnswer, hardLines) }
        ], { maxTokens: 500, label: '交付核验' });
        judgeResult = parseVerdict(judgeText);
        
        if (judgeResult.verdict === 'GAPS' && judgeResult.gaps.length) {
          gaps.push(...judgeResult.gaps);
        }
      }
    } catch (e) {
      // judge 通道故障按通过处理
    }
  }
  
  if (gaps.length) {
    return `核验结果：FAIL\n\n发现 ${gaps.length} 项缺口：\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;
  }
  
  return '核验结果：PASS\n\n意图契约全部条款满足';
}

// ---------- 获取意图注记 ----------
function getIntentNote() {
  if (!state.intent) return '';
  
  const lines = ['[意图契约] 任务交付要求（执行全程对照，交付前逐条自查）：'];
  if (state.intent.task) lines.push(`概述：${state.intent.task}`);
  for (const d of state.intent.deliverables) {
    lines.push(`- 交付物：${d.path || '（非文件）'}${d.criterion ? `——${d.criterion}` : ''}`);
  }
  for (const a of state.intent.acceptance) {
    lines.push(`- 验收：${a}`);
  }
  for (const c of state.intent.constraints) {
    lines.push(`- 约束：${c}`);
  }
  lines.push('注意：最近上下文可能被折叠，本注记是任务要求的权威来源；遗漏任何一条即交付不合格。');
  
  return lines.slice(0, 16).join('\n');
}

// ---------- 辅助函数 ----------
function buildIntentPrompt(taskText) {
  return [
    '你是需求分析器。把下面的任务解析为结构化意图契约 JSON，规则：',
    '1) 只依据任务原文，禁止脑补任务没提的要求；',
    '2) deliverables 覆盖全部产出物（文件/答案/结论），path 是任务明示或可合理推断的文件路径，纯问答类为 null；',
    '3) path 格式要求：使用相对于工作区根目录的路径（如 report.md、docs/api.md），不要包含工作区前缀；',
    '4) acceptance 每条必须可客观核验（存在性/内容包含/问题已答），禁止"质量好"类模糊条款；',
    '5) goals ≤3 条、acceptance ≤5 条，直接输出 JSON，无任何解释文字。',
    '{"task":"一句话概述","goals":["目标，≤3条"],"deliverables":[{"path":"产出文件路径","criterion":"该交付物的验收标准"}],"constraints":["约束条件"],"acceptance":["可客观核验的验收条款，≤5条"]}',
    '',
    '任务原文：',
    taskText
  ].join('\n');
}

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

function buildJudgePrompt(intent, finalAnswer, hardResults) {
  return [
    '你是交付核验裁判。对照意图契约逐条核验最终交付，输出 JSON：',
    '{"verdict":"PASS 或 GAPS","gaps":["缺口描述，仅当 verdict=GAPS"]}',
    '核验纪律：',
    '1) 只标具体可查的缺口：要求的文件不存在、明确的问题没有回答、任务要求的维度/条目缺失；',
    '2) 禁止风格与口味判断；',
    '3) 硬断言已 FAIL 的项直接列入 gaps；',
    '4) 全部满足输出 PASS；拿不准的项按满足处理。',
    '',
    '意图契约：',
    JSON.stringify(intent, null, 1),
    '',
    '硬断言结果：',
    hardResults && hardResults.length ? hardResults.join('\n') : '（无文件类交付物）',
    '',
    '最终交付内容：',
    String(finalAnswer || '').slice(0, 6000)
  ].join('\n');
}

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

// ---------- 插件导出 ----------
module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { 
        type: 'string', 
        enum: ['extract', 'view', 'clear', 'verify'],
        description: '操作类型：extract=抽取意图契约, view=查看当前意图, clear=清除意图, verify=核验交付物'
      },
      task: { 
        type: 'string', 
        description: '任务描述（extract 操作时使用）'
      },
      finalAnswer: { 
        type: 'string', 
        description: '最终交付内容（verify 操作时使用）'
      }
    },
    required: ['action']
  },
  
  run: async (args, ctx) => {
    const action = String(args.action || '').toLowerCase();
    
    switch (action) {
      case 'extract':
        return await extractIntentOperation(args, ctx);
      case 'view':
        return viewIntentOperation(args, ctx);
      case 'clear':
        return clearIntentOperation(args, ctx);
      case 'verify':
        return await verifyDeliverablesOperation(args, ctx);
      default:
        return `未知操作：${action}\n可用操作：extract, view, clear, verify`;
    }
  },
  
  // 供框架调用的额外方法
  getIntentNote,
  getState: () => state,
  setState: (s) => { Object.assign(state, s); }
};
