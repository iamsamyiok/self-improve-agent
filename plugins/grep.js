// @name grep
// @desc 工作区内容检索：按关键词/短语找文件并给出命中片段（BM25 相关性排序，中文 bigram + 英文词元分词）。纯 JS 自包含零依赖，比逐个 read 翻找快一个数量级
// @essential false
// 设计约束：与 tree/read 同源的路径沙箱（工作区越界拒绝）；忽略 node_modules/.git/二进制/超大文件；
// BM25(k1=1.5,b=0.75) 相关性排序——"按内容找文件"比文件名 tree 浏览的命中精度高得多。
const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules', '.git', '.archives', '.data', 'dist', 'build']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.html', '.css', '.scss', '.less', '.vue', '.py', '.go', '.rs', '.java', '.sh', '.yml', '.yaml', '.xml', '.sql', '.env', '.toml', '.ini', '.cfg']);
const MAX_FILE_BYTES = 256 * 1024; // 单文件上限：超过按二进制/巨型文件跳过
const MAX_FILES = 800;             // 索引文件数上限（防巨型工作区拖垮查询）
const MAX_SNIPPET = 160;           // 命中片段截断长度

// 分词：英文 [a-z0-9]+ 词元 + 中文连续段切 bigram（与 evolution 靶向校验同源思路）
function tokenize(s) {
  const out = [];
  const lower = String(s || '').toLowerCase();
  const re = /[a-z0-9]+|[\u4e00-\u9fff]+/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const t = m[0];
    if (/^[a-z0-9]+$/.test(t)) { out.push(t); continue; }
    if (t.length === 1) { out.push(t); continue; }
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  }
  return out;
}

// BM25 打分：idf = ln(1 + (N - df + 0.5) / (df + 0.5))
function bm25Scores(queryTokens, docs) {
  const N = docs.length;
  if (!N) return [];
  let avgdl = 0;
  for (const d of docs) avgdl += d.tokens.length;
  avgdl = avgdl / N || 1;
  const df = {};
  const qSet = [...new Set(queryTokens)];
  for (const q of qSet) {
    let n = 0;
    for (const d of docs) { if (d.tf.has(q)) n++; }
    df[q] = n;
  }
  const k1 = 1.5, b = 0.75;
  return docs.map(d => {
    let score = 0;
    for (const q of qSet) {
      if (!d.tf.has(q) || !df[q]) continue;
      const f = d.tf.get(q);
      const idf = Math.log(1 + (N - df[q] + 0.5) / (df[q] + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.tokens.length / avgdl));
    }
    return { doc: d, score };
  }).filter(x => x.score > 0).sort((a, b2) => b2.score - a.score);
}

// 命中片段：取第一条命中行（截断），展示给模型定位上下文
function snippet(fp, queryTokens) {
  let text = '';
  try { text = fs.readFileSync(fp, 'utf8'); } catch { return ''; }
  const lines = text.split('\n');
  const qSet = [...new Set(queryTokens)];
  for (const line of lines) {
    const toks = tokenize(line);
    if (toks.some(t => qSet.includes(t))) {
      const trimmed = line.trim();
      return trimmed.length > MAX_SNIPPET ? trimmed.slice(0, MAX_SNIPPET) + '…' : trimmed;
    }
  }
  return '';
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索关键词或短语（支持中英文，多词任一命中即计分，相关度排序）' },
      dir: { type: 'string', description: '检索起始目录（默认工作区根；相对路径）' },
      topk: { type: 'number', description: '返回文件数上限（默认 10，上限 30）' }
    },
    required: ['query']
  },
  run: async (args, ctx) => {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query 不能为空');
    let userDir = String(args.dir || '');
    if (ctx.cwd && userDir.startsWith(ctx.cwd)) {
      userDir = userDir.slice(ctx.cwd.length).replace(/^[/\\]/, '');
    }
    const root = path.resolve(ctx.cwd, userDir);
    if (!root.startsWith(ctx.cwd)) throw new Error(`路径越界：${args.dir}`);
    if (!fs.existsSync(root)) throw new Error(`目录不存在：${args.dir || '.'}（可先 tree 看工作区结构）`);
    const topk = Math.max(1, Math.min(Math.floor(Number(args.topk) || 10), 30));
    const qTokens = tokenize(query);
    if (!qTokens.length) throw new Error(`query 无法分词：${query}`);

    // 收集文本文件
    const docs = [];
    const walk = (dir, depth) => {
      if (depth > 8 || docs.length >= MAX_FILES) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (docs.length >= MAX_FILES) break;
        if (e.name.startsWith('.') && e.name !== '.env') continue;
        if (IGNORE.has(e.name)) continue;
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { walk(fp, depth + 1); continue; }
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (ext && !TEXT_EXT.has(ext)) continue;
        let size = 0;
        try { size = fs.statSync(fp).size; } catch { continue; }
        if (size > MAX_FILE_BYTES || size === 0) continue;
        let text = '';
        try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        if (/\u0000/.test(text.slice(0, 512))) continue; // 二进制特征
        const tokens = tokenize(text);
        if (!tokens.length) continue;
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        docs.push({ fp, rel: path.relative(ctx.cwd, fp) || e.name, tokens, tf });
      }
    };
    walk(root, 0);

    if (!docs.length) return `工作区未索引到文本文件（目录：${userDir || '.'}）。用 tree 确认目录结构`;
    const ranked = bm25Scores(qTokens, docs).slice(0, topk);
    if (!ranked.length) {
      return `无文件命中「${query}」（已扫描 ${docs.length} 个文本文件）。尝试换关键词，或用 read 直接查看疑似文件`;
    }
    const lines = ranked.map((r, i) => {
      const snip = snippet(r.doc.fp, qTokens);
      return `${i + 1}. ${r.doc.rel}（相关度 ${r.score.toFixed(2)}）${snip ? '\n   └ ' + snip : ''}`;
    });
    return `内容检索「${query}」命中 ${ranked.length}/${docs.length} 个文件（BM25 排序）：\n\n` + lines.join('\n');
  }
};
