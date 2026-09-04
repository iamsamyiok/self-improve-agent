// @name usage
// @desc token 用量查询：get 当前工作区累计与最近调用明细 / history 按会话分组（数据源 inner-usage.json，优先 API 真实返回，est=估算）
// @essential false
const fs = require('fs');
const path = require('path');

function usageFile(ctx) { return path.join(ctx.cwd, 'inner-usage.json'); }

// 数据源：inner-usage.jsonl（v3.4.0 JSONL 追加写）优先，兼容旧 inner-usage.json 数组格式
function load(ctx) {
  try {
    const jl = usageFile(ctx).replace(/\.json$/, '.jsonl');
    const rows = fs.readFileSync(jl, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (rows.length) return rows;
  } catch { /* 无 JSONL 回退旧格式 */ }
  try {
    const d = JSON.parse(fs.readFileSync(usageFile(ctx), 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

const fmt = n => Number(n || 0).toLocaleString('en-US');

// 按 10 分钟调用空档切分会话（无显式会话 id，时间聚类足够可靠）
function sessions(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || r.ts - cur.end > 10 * 60 * 1000) { cur = { start: r.ts, end: r.ts, rows: [] }; out.push(cur); }
    cur.end = r.ts;
    cur.rows.push(r);
  }
  return out;
}

function summarize(rows) {
  return {
    calls: rows.length,
    prompt: rows.reduce((n, r) => n + (r.prompt || 0), 0),
    completion: rows.reduce((n, r) => n + (r.completion || 0), 0),
    cached: rows.reduce((n, r) => n + (r.cached || 0), 0),
    estCalls: rows.filter(r => r.est).length
  };
}

// 口径说明：模型估算差两个数量级的病根就是混淆了"累计计费"与"净上下文"，必须显式教
const CALIBER = [
  '口径说明（回答用量问题必须先声明口径）：',
  '- API 计费口径（上表数字）：每次调用都全量重发上下文（系统提示+技能清单+历史+全部工具结果），多轮任务的累计 prompt 远大于净上下文体积，这是实际扣费量。',
  '- 净上下文口径：单次调用发送的消息体积，约等于最近一行的 prompt 值。',
  '- prompt 含缓存命中部分（cached 列）时，多数厂商对命中部分按折扣计费或免费。',
  '- est 标记的行为字符折算估算（网关未返回 usage），误差约 ±30%；无 est 的行为 API 真实返回，可直接引用。'
].join('\n');

// 对外暴露函数供 server 路由直接调用
function getUsage(ctx) {
  const rows = load(ctx || { cwd: process.cwd() });
  const s = summarize(rows);
  return {
    totalsPrompt: s.prompt,
    totalsCompletion: s.completion,
    totalsCached: s.cached,
    totalsCalls: s.calls,
    estCalls: s.estCalls,
    recent: rows.slice(-10).map(r => ({
      ts: r.ts,
      prompt: r.prompt,
      completion: r.completion,
      cached: r.cached,
      est: !!r.est,
      totalsPrompt: r.totalsPrompt,
      totalsCompletion: r.totalsCompletion,
      totalsCalls: r.totalsCalls
    }))
  };
}

function getSessions(ctx) {
  const rows = load(ctx || { cwd: process.cwd() });
  const list = sessions(rows);
  return {
    sessions: list.map(sess => {
      const x = summarize(sess.rows);
      return {
        start: sess.start,
        end: sess.end,
        calls: sess.rows.length,
        prompt: x.prompt,
        completion: x.completion,
        cached: x.cached
      };
    }),
    totalCalls: rows.length,
    totalPrompt: rows.reduce((n, r) => n + (r.prompt || 0), 0),
    totalCompletion: rows.reduce((n, r) => n + (r.completion || 0), 0)
  };
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'history'], description: 'get：当前工作区累计与最近明细 / history：按会话分组汇总' },
      limit: { type: 'number', description: 'get 可选：最近 N 条明细（默认 10）' }
    },
    required: ['action']
  },
  run: async (args, ctx) => {
    const rows = load(ctx);
    if (!rows.length) return '当前工作区尚无 token 计量记录（inner-usage.json 为空）。真实模式执行一次任务后即可采集；本数据源优先取 API 真实返回的 usage。';
    if (args.action === 'get') {
      const s = summarize(rows);
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 50));
      const detail = rows.slice(-limit).map((r, i) => {
        const no = rows.length - limit + i + 1;
        return `${no}. ${new Date(r.ts).toLocaleString('zh-CN')} prompt ${fmt(r.prompt)} + 输出 ${fmt(r.completion)}${r.cached ? `（缓存 ${fmt(r.cached)}）` : ''}${r.est ? ' [估算]' : ' [真实]'}`;
      }).join('\n');
      return [
        `当前工作区 token 用量（数据源 inner-usage.json，共 ${rows.length} 次 API 调用）：`,
        `累计（API 计费口径）：prompt ${fmt(s.prompt)} + 输出 ${fmt(s.completion)} = ${fmt(s.prompt + s.completion)} tok${s.cached ? `，其中缓存命中 ${fmt(s.cached)}` : ''}`,
        `其中 ${s.estCalls} 次为估算值（est），${rows.length - s.estCalls} 次为 API 真实返回。`,
        '',
        `最近 ${Math.min(limit, rows.length)} 次调用明细：`,
        detail,
        '',
        CALIBER
      ].join('\n');
    }
    if (args.action === 'history') {
      const list = sessions(rows);
      const s = summarize(rows);
      const lines = list.map((sess, i) => {
        const x = summarize(sess.rows);
        const t0 = new Date(sess.start).toLocaleString('zh-CN');
        return `会话 ${i + 1}（${t0} 起，${sess.rows.length} 次调用）：prompt ${fmt(x.prompt)} + 输出 ${fmt(x.completion)} = ${fmt(x.prompt + x.completion)} tok${x.cached ? `（缓存 ${fmt(x.cached)}）` : ''}`;
      });
      return [`按会话分组（10 分钟调用空档切分），总计 ${list.length} 个会话 / ${rows.length} 次调用：`, ...lines, '', `全部累计：prompt ${fmt(s.prompt)} + 输出 ${fmt(s.completion)} = ${fmt(s.prompt + s.completion)} tok`, '', CALIBER].join('\n');
    }
    throw new Error(`未知操作：${args.action}（支持 get/history）`);
  }
};

// 对外导出纯数据函数，供 server 路由直接调用（避免通过插件 run 方法间接调用）
module.exports.getUsage = getUsage;
module.exports.getSessions = getSessions;
