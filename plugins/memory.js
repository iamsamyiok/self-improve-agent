// @name memory
// @desc 五层记忆系统：session/short/long（日常）+ archive（任务归档全文检索）+ vector（语义向量记忆 remember/recall）
// @essential true
const fs = require('fs');
const path = require('path');

const MAX_SHORT = 20;
const MAX_LONG = 20;
const ARCHIVE_FILE = 'memory-archive.jsonl'; // 任务归档（user + finalText，JSONL 追加，无上限）
const VECTOR_FILE = '.memory-vector.json';   // 语义记忆库（content + tags + Int8 量化稠密向量）
const COS_MERGE = 0.85; // remember 自动合并阈值（对齐 Hermes 语义记忆）
// Embedding 申请指引（硅基流动免费 bge-m3；remember 未配置提示 / emb_test 失败提示共用）
const EMB_HELP = '推荐硅基流动免费模型 BAAI/bge-m3（1024 维，单条 8192 tokens）：\n' +
  '1) 打开 https://cloud.siliconflow.cn/account/ak 注册/登录硅基流动；\n' +
  '2) 点「新建 API 密钥」→ 复制 sk- 开头的密钥；\n' +
  '3) 配置 base_url=https://api.siliconflow.cn/v1、api_key=你的密钥、model=BAAI/bge-m3（网页版设置面板或 hwj /config 向导均可填写）。';

function memFiles(ctx) {
  return {
    short: path.join(ctx.cwd, '.memory-short.json'),
    long: path.join(ctx.cwd, '.memory-long.json'),
    vector: path.join(ctx.cwd, VECTOR_FILE)
  };
}

function loadJSON(fp, fallback = []) {
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(d) ? d : fallback;
  } catch { return fallback; }
}

function saveJSON(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  try { fs.writeFileSync(fp, JSON.stringify(data, null, 1), 'utf8'); }
  catch (e) { console.error('[memory] 记忆落盘失败:', e && e.message || e); return false; }
  return true;
}

// 单调递增 id：seq 文件持久化计数器；兜底不低于现存最大 id（防手改/迁移回退）
// 旧版用 arr.length + 1，删除条目后 id 冲突会命中错条目
function allocId(file) {
  const seqFp = file + '.seq';
  let seq = 0;
  try { seq = Number(JSON.parse(fs.readFileSync(seqFp, 'utf8')).seq) || 0; } catch { /* 首次初始化 */ }
  const maxExisting = loadJSON(file, []).reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
  seq = Math.max(seq, maxExisting) + 1;
  try { fs.mkdirSync(path.dirname(seqFp), { recursive: true }); fs.writeFileSync(seqFp, JSON.stringify({ seq }), 'utf8'); } catch (e) { console.error('[memory] id 计数器落盘失败:', e && e.message || e); }
  return seq;
}

// tags 归一化：模型偶发传字符串（"['a','b']" 或 "a,b"），统一转字符串数组
function normTags(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.map(t => String(t).trim()).filter(Boolean);
  } catch { /* 继续分隔解析 */ }
  return s.split(/[,;，；]\s*/).map(t => t.replace(/^['"\\[\\]]+|['"\\[\\]]+$/g, '').trim()).filter(Boolean);
}

// ---------- 检索：轻量 TF-IDF ----------
// 中英混合分词：英文按词、中文按 2-gram（零依赖，对短查询/短记忆召回远好于子串匹配）
function tokenize(s) {
  const out = [];
  const en = String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,30}/g) || [];
  out.push(...en);
  const zh = String(s || '').match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of zh) {
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    if (seg.length === 2) out.push(seg); // 完整双字词去重无害
  }
  return out;
}

// 打分：query 词频 × IDF（记忆库维度）；命中数相同按 id 新→旧
function scoreMemory(queryTokens, m, idf) {
  const toks = tokenize(`${m.content} ${(m.tags || []).join(' ')}`);
  if (!toks.length) return 0;
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  let s = 0;
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (f) s += (1 + Math.log(f)) * (idf.get(q) || 1.5); // 未见词给中性 IDF
  }
  return s;
}

function searchRanked(query, items) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return [];
  // IDF：在候选集中
  const df = new Map();
  for (const m of items) {
    const seen = new Set(tokenize(`${m.content} ${(m.tags || []).join(' ')}`));
    for (const t of seen) if (qTokens.includes(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + items.length / n));
  return items
    .map(m => ({ m, s: scoreMemory(qTokens, m, idf) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.m.id || 0) - (a.m.id || 0))
    .map(x => x.m);
}

// ---------- 归档层（对齐 Hermes state.db：全量任务原文，JSONL 追加 + BM25 全文检索） ----------
function loadArchive(ctx) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(ctx.cwd, ARCHIVE_FILE), 'utf8'); } catch { return []; }
  return raw.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { const o = JSON.parse(l); return o && (o.user || o.finalText) ? o : null; } catch { return null; } })
    .filter(Boolean);
}

function appendArchive(ctx, entry) {
  const fp = path.join(ctx.cwd, ARCHIVE_FILE);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------- BM25（归档检索 + 语义记忆稀疏路共用；k1=1.5 b=0.75 标准参数） ----------
// 与 searchRanked 的 TF-IDF 互补：BM25 带文档长度归一，长文档（归档 finalText）不虚高
function bm25Search(query, docs, textOf, topN = 20) {
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length || !docs.length) return [];
  const N = docs.length;
  const docToks = docs.map(d => tokenize(textOf(d)));
  const avgLen = docToks.reduce((s, t) => s + t.length, 0) / N || 1;
  const df = new Map();
  for (const toks of docToks) {
    for (const t of new Set(toks)) if (qTokens.includes(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const k1 = 1.5, b = 0.75;
  return docs.map((d, i) => {
      const toks = docToks[i];
      if (!toks.length) return { d, s: 0 };
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      let s = 0;
      for (const q of qTokens) {
        const f = tf.get(q);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * toks.length / avgLen));
      }
      return { d, s };
    })
    .filter(x => x.s > 0)
    .sort((a, b2) => b2.s - a.s)
    .slice(0, topN);
}

// ---------- 语义向量层（对齐 Hermes LanceDB 插件：稠密余弦 + 稀疏 BM25 + RRF 融合） ----------
// 存储规模说明：Int8 量化后每条 ~4KB，1 万条 ≈ 40MB JSON，readFileSync 全量加载百 ms 级；
// 超过 1 万条建议分工作区。模块不设缓存（插件支持热加载，缓存会失效），每次现读现算
function loadVector(ctx) {
  try {
    const d = JSON.parse(fs.readFileSync(memFiles(ctx).vector, 'utf8'));
    return Array.isArray(d.items) ? d : { items: [] };
  } catch { return { items: [] }; }
}

function saveVector(ctx, data) {
  return saveJSON(memFiles(ctx).vector, data);
}

// L2 归一化后 Int8 量化：值域压到 [-127,127]，文件体积比 float JSON 小 5 倍，top-N 排序几乎无损
function quantize(vec) {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map(v => Math.max(-127, Math.min(127, Math.round((v / norm) * 127))));
}

function cosInt8(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// embedding 配置：读 .data/config.json 的 embedding 段（与内层 API 同一配置文件，网页版/hwj 共享）
// 未配置返回 null（调用方降级关键词模式，功能不阻断）
function readEmbeddingCfg(ctx) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'config.json'), 'utf8'));
    const e = cfg && cfg.embedding;
    return (e && e.base_url && e.api_key && e.model) ? e : null;
  } catch { return null; }
}

// OpenAI 兼容 /embeddings 调用（硅基流动 BAAI/bge-m3 等通用）；15s 超时
// 硅基流动批量限制：数组 ≤32 条且每条 ≤512 tokens（单条 string 调用为 8192）——
// 统一截 480 字符兜底（记忆条目上限 1000 字符，前 480 字符的向量表征已足够检索）
async function embedTexts(texts, cfgE) {
  const input = texts.map(t => String(t).slice(0, 480));
  const url = String(cfgE.base_url).replace(/\/+$/, '') + '/embeddings';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfgE.api_key },
    body: JSON.stringify({ model: cfgE.model, input }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`embedding API HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  const arr = (j && j.data || []).map(x => x && x.embedding).filter(Array.isArray);
  if (arr.length !== input.length) throw new Error(`embedding 返回 ${arr.length} 条，期望 ${input.length} 条`);
  return arr;
}

// query embedding 缓存（P2-6）：相同问题 60s 内重问不重复调 API——预取与模型主动 recall
// 常对同一 query 各调一次；只缓存单条查询（recall 路径），写入路径（remember 批量向量化）不用
const _qEmbCache = new Map(); // key -> { ts, vec }，简易 FIFO 上限 20 条
async function embedQueryCached(query, cfgE) {
  const key = String(query).slice(0, 480);
  const hit = _qEmbCache.get(key);
  if (hit && Date.now() - hit.ts < 60000) return [hit.vec];
  const [vec] = await embedTexts([key], cfgE);
  _qEmbCache.set(key, { ts: Date.now(), vec });
  if (_qEmbCache.size > 20) _qEmbCache.delete(_qEmbCache.keys().next().value);
  return [vec];
}

// RRF 倒数排名融合（k=60 标准值）：两路排名值域不统一，用 1/(k+rank) 相加
function rrfFuse(rankLists, topK) {
  const K = 60;
  const score = new Map();
  for (const list of rankLists) {
    list.forEach((id, r) => score.set(id, (score.get(id) || 0) + 1 / (K + r + 1)));
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['save', 'search', 'list', 'delete', 'consolidate', 'archive_save', 'archive_search', 'remember', 'recall', 'emb_test'],
        description: 'save/search/list/delete=三层记忆管理；consolidate=短期归并为长期；archive_save=归档完整任务记录（用户消息+最终交付）；archive_search=BM25 全文检索历史任务归档；remember=写入长期语义记忆（经验/事实/方案，支持向量语义检索）；recall=语义混合检索（稠密向量+BM25 关键词 RRF 融合，embedding 未配置时自动降级关键词）；emb_test=测试 Embedding API 连通性（配置界面保存后验证用）'
      },
      level: {
        type: 'string',
        enum: ['session', 'short', 'long', 'vector'],
        description: '记忆级别：session=会话级（不持久化）/ short=近期（任务摘要）/ long=长期（永久）/ vector=语义记忆（remember 写入的条目）'
      },
      content: { type: 'string', description: '记忆内容（save 时必填）' },
      query: { type: 'string', description: '检索关键词（search 时必填）' },
      id: { type: 'number', description: '删除时的条目 ID' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签（save/remember 时可选；recall 时可作前置过滤）' },
      user: { type: 'string', description: 'archive_save：用户原始消息' },
      finalText: { type: 'string', description: 'archive_save：最终交付文本' },
      top_k: { type: 'number', description: 'recall 返回条数（默认 5，上限 10）' },
      mode: { type: 'string', enum: ['hybrid', 'vector', 'keyword'], description: 'recall 检索模式：hybrid=语义+关键词融合（默认）/ vector=仅语义 / keyword=仅关键词' }
    },
    required: ['action']
  },
  
  run: async (args, ctx) => {
    const files = memFiles(ctx);
    const action = args.action;
    const level = args.level || 'short';
    const tags = normTags(args.tags); // 字符串/数组归一化（模型常传字符串）
    
    // ========== save ==========
    if (action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空'); // 软失败统一 throw → 框架标记 ok=false，防模型误读成功
      
      if (level === 'session') {
        // 会话级：不持久化，只返回提示
        return '会话级记忆由框架自动管理，无需手动保存';
      }
      
      // 去重检查：仅精确内容匹配视为重复（旧版关键词/标签模糊命中会把不同事实误判为已存在，静默丢数据）
      const checkLevel = level === 'long' ? 'long' : 'short';
      const existing = loadJSON(files[checkLevel], []).filter(m => m.content === content);
      if (existing.length > 0) {
        return `记忆已存在（#${existing[existing.length - 1].id}），内容完全相同，无需重复保存`;
      }

      // 同标签/相似记忆一律追加（旧版“同标签覆盖第一条”会静默覆盖不同事实）
      if (level === 'short') {
        const arr = loadJSON(files.short, []);
        const item = {
          id: allocId(files.short),
          ts: Date.now(),
          content: content.slice(0, 500),
          tags: tags.slice(0, 3),
          taskId: args.taskId || null
        };
        arr.push(item);
        while (arr.length > MAX_SHORT) arr.shift();
        if (!saveJSON(files.short, arr)) return '近期记忆保存失败：磁盘写入异常';
        return `已保存到近期记忆 #${item.id}：${content.slice(0, 50)}...`;
      }

      if (level === 'long') {
        const arr = loadJSON(files.long, []);
        const item = {
          id: allocId(files.long),
          ts: Date.now(),
          content: content.slice(0, 1000),
          tags: tags.slice(0, 5),
          priority: args.priority || 'normal'
        };
        arr.push(item);
        while (arr.length > MAX_LONG) arr.shift();
        if (!saveJSON(files.long, arr)) return '长期记忆保存失败：磁盘写入异常';
        return `已保存到长期记忆 #${item.id}：${content.slice(0, 50)}...`;
      }
    }
    
    // ========== search：TF-IDF 语义排序（中英混合分词，中文 2-gram；子串匹配升级） ==========
    if (action === 'search') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query 为空'); // 软失败统一 throw → 框架标记 ok=false
      // 病根（v0.9.4 实测发现）：search 复用了 save 的 level 默认值 'short'，
      // 模型把重要信息存 long 后不带 level 检索（最常见用法）→ 必然零命中，记忆像丢了一样。
      // 检索的合理默认是跨库（all），显式传 level 才收窄。
      const searchLevel = args.level !== undefined ? args.level : 'all';

      const pool = [];
      if (searchLevel === 'short' || searchLevel === 'all') {
        loadJSON(files.short, []).forEach(m => pool.push({ level: 'short', ...m }));
      }
      if (searchLevel === 'long' || searchLevel === 'all') {
        loadJSON(files.long, []).forEach(m => pool.push({ level: 'long', ...m }));
      }
      const ranked = searchRanked(query, pool);
      if (!ranked.length) {
        return `没有匹配「${query}」的记忆`;
      }
      const lines = ranked.slice(0, 5).map(m => {
        const tagStr = (m.tags || []).length ? ` [${m.tags.join(' ')}]` : '';
        return `#${m.id} [${m.level}]${tagStr} ${m.content}`;
      });
      return `匹配 ${ranked.length} 条（相关度排序）：\n${lines.join('\n')}`;
    }
    
    // ========== list ==========
    if (action === 'list') {
      const short = loadJSON(files.short, []);
      const long = loadJSON(files.long, []);
      
      if (!short.length && !long.length) {
        return '记忆库为空';
      }
      
      const lines = [];
      if (short.length) {
        lines.push(`【近期记忆】共 ${short.length} 条：`);
        lines.push(...short.slice(-5).reverse().map(m => `  #${m.id} ${m.content.slice(0, 60)}`));
      }
      if (long.length) {
        lines.push(`【长期记忆】共 ${long.length} 条：`);
        lines.push(...long.slice(-5).reverse().map(m => `  #${m.id} [${m.priority}] ${m.content.slice(0, 60)}`));
      }
      return lines.join('\n');
    }
    
    // ========== consolidate：相似短期记忆归并 ==========
    // 病根：MAX_SHORT=20 滚动淘汰，同一任务的多条过程记忆会被新任务挤出且碎片化。
    // 归并策略：Jaccard 相似（分词集合）≥0.45 的短期记忆簇 → 合并为一条长期记忆
    //（保留全部原文要点与最新 id/ts），原条目从短期库移除释放容量
    if (action === 'consolidate') {
      const short = loadJSON(files.short, []);
      if (short.length < 2) return '近期记忆不足 2 条，无需归并';
      const long = loadJSON(files.long, []);
      const tokensOf = m => new Set(tokenize(`${m.content} ${(m.tags || []).join(' ')}`));
      const zhGram = s => new Set((String(s).match(/[\u4e00-\u9fff]{2}/g) || []));
      const asciiWord = s => new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []));
      const jaccard = (a, b) => {
        if (!a.size || !b.size) return 0;
        let inter = 0;
        for (const t of a) if (b.has(t)) inter++;
        return inter / (a.size + b.size - inter);
      };
      // 同主题判定（双通道）：
      // 1) 2-gram Jaccard ≥ 0.3（表述相近的归并）
      // 2) 强信号：共同中文 2-gram ≥1 且共同 ASCII 词 ≥1（「任务weather：xxx」这类混排前缀主题）
      const sameTopic = (a, b) => {
        if (jaccard(tokensOf(a), tokensOf(b)) >= 0.3) return true;
        const za = zhGram(a.content), zb = zhGram(b.content);
        const aa = asciiWord(a.content), ab = asciiWord(b.content);
        let zhHit = false, enHit = false;
        for (const g of za) if (zb.has(g)) { zhHit = true; break; }
        for (const w of aa) if (ab.has(w)) { enHit = true; break; }
        return zhHit && enHit;
      };
      const clusters = [];
      const used = new Set();
      for (let i = 0; i < short.length; i++) {
        if (used.has(i)) continue;
        const cluster = [i];
        for (let j = i + 1; j < short.length; j++) {
          if (used.has(j)) continue;
          if (cluster.some(ci => sameTopic(short[ci], short[j]))) {
            cluster.push(j);
            used.add(j);
          }
        }
        used.add(i);
        if (cluster.length >= 2) clusters.push(cluster);
      }
      if (!clusters.length) return '未发现足够相似的短期记忆簇（阈值 0.3），无需归并';
      const mergedIds = [];
      const keep = short.filter((m, i) => !used.has(i) || !clusters.some(c => c.includes(i)));
      for (const cluster of clusters) {
        const items = cluster.map(i => short[i]).sort((a, b) => (a.id || 0) - (b.id || 0));
        const tags = [...new Set(items.flatMap(m => m.tags || []))].slice(0, 5);
        const topic = items[0].content.slice(0, 30);
        const merged = {
          id: allocId(files.long),
          ts: Date.now(),
          content: `【归并 ${items.length} 条】主题：${topic}\n${items.map(m => `- ${m.content}`).join('\n')}`.slice(0, 1000),
          tags: tags.length ? tags : ['归并'],
          priority: 'normal',
          mergedFrom: items.map(m => m.id),
        };
        long.push(merged);
        mergedIds.push(`#${merged.id} ← ${items.map(m => '#' + m.id).join(' + ')}`);
      }
      while (long.length > MAX_LONG) long.shift();
      saveJSON(files.short, keep);
      saveJSON(files.long, long);
      return `已归并 ${clusters.length} 簇（近期 ${short.length} → ${keep.length} 条）：\n${mergedIds.join('\n')}`;
    }

    // ========== archive_save：归档完整任务记录（框架收尾自动调用 / 模型手动归档） ==========
    if (action === 'archive_save') {
      const user = String(args.user || '').trim();
      const finalText = String(args.finalText || '').trim();
      if (!user && !finalText) throw new Error('user 与 finalText 至少一项非空');
      appendArchive(ctx, {
        ts: Date.now(),
        taskId: args.taskId || null,
        user: user.slice(0, 2000),
        finalText: finalText.slice(0, 4000)
      });
      return `已归档 1 条任务记录（归档累计 ${loadArchive(ctx).length} 条，archive_search 可全文检索）`;
    }

    // ========== archive_search：BM25 全文检索历史任务归档 ==========
    if (action === 'archive_search') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query 为空');
      const docs = loadArchive(ctx);
      if (!docs.length) return '任务归档库为空';
      const hits = bm25Search(query, docs, d => `${d.user || ''} ${d.finalText || ''}`, 10);
      if (!hits.length) return `归档中没有匹配「${query}」的任务记录`;
      const lines = hits.map(({ d }) => {
        const when = new Date(d.ts).toISOString().slice(0, 16).replace('T', ' ');
        const u = (d.user || '').replace(/\s+/g, ' ').slice(0, 60);
        const f = (d.finalText || '').replace(/\s+/g, ' ').slice(0, 120);
        return `[${when}] 问：${u}${(d.user || '').length > 60 ? '…' : ''}\n  答：${f}${(d.finalText || '').length > 120 ? '…' : ''}`;
      });
      return `归档匹配 ${hits.length} 条（BM25 相关度排序）：\n${lines.join('\n')}`;
    }

    // ========== emb_test：Embedding API 连通性测试（配置界面保存后验证） ==========
    if (action === 'emb_test') {
      const cfgE = readEmbeddingCfg(ctx);
      if (!cfgE) {
        return '未配置 embedding（.data/config.json 的 embedding 段缺 base_url / api_key / model）。\n' + EMB_HELP;
      }
      const t0 = Date.now();
      try {
        const [v] = await embedTexts(['连通性测试'], cfgE);
        return `连接成功：${cfgE.model} @ ${cfgE.base_url}，返回 ${v.length} 维向量，耗时 ${Date.now() - t0}ms。语义记忆 remember/recall 已就绪`;
      } catch (e) {
        return `连接失败：${e && e.message || e}\n请检查三项配置（base_url 须含 /v1、api_key 以 sk- 开头、model 如 BAAI/bge-m3）。${EMB_HELP}`;
      }
    }

    // ========== remember：写入语义记忆（稠密向量 + 原文，供 recall 混合检索） ==========
    if (action === 'remember') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空');
      const data = loadVector(ctx);
      const items = data.items;
      // 精确重复直接拒绝（与 save 同策略）
      const dup = items.find(it => it.content === content);
      if (dup) return `语义记忆已存在（#${dup.id}），内容完全相同，无需重复写入`;

      // embedding 可用则生成稠密向量（归一化 Int8 量化）
      const cfgE = readEmbeddingCfg(ctx);
      let dense = null;
      let note = `未配置 embedding，当前仅关键词可检索。${EMB_HELP}`;
      if (cfgE) {
        try {
          // 渐进式 backfill：为无向量的存量条目补嵌（每次最多 10 条，与新内容合并成一次 API 调用）
          // 场景：先无配置积累 sparse-only 记忆，后配置 embedding —— 存量逐步进入语义检索
          const backfill = items.filter(it => !Array.isArray(it.dense)).slice(0, 10);
          const [vNew, ...vOld] = await embedTexts([content, ...backfill.map(it => it.content)], cfgE);
          dense = quantize(vNew);
          backfill.forEach((it, i) => {
            if (Array.isArray(vOld[i]) && vOld[i].length === vNew.length) it.dense = quantize(vOld[i]);
          });
          note = `语义+关键词双路可检索${backfill.length ? `（本次补嵌存量 ${backfill.length} 条）` : ''}`;
        } catch (e) {
          return `语义向量生成失败，本次未写入：${e && e.message || e}（可稍后重试，或检查 embedding 配置）`;
        }
      }

      // 高相似自动合并（对齐 Hermes >0.85 LLM 合并；插件层无 LLM 访问权，用追加式合并保留全部信息）
      if (dense) {
        let best = null, bestS = 0;
        for (const it of items) {
          if (!Array.isArray(it.dense) || it.dense.length !== dense.length) continue;
          const s = cosInt8(dense, it.dense);
          if (s > bestS) { bestS = s; best = it; }
        }
        if (best && bestS > COS_MERGE) {
          best.content = `${best.content}\n【补充】${content}`.slice(0, 1000);
          best.ts = Date.now();
          best.tags = [...new Set([...(best.tags || []), ...tags])].slice(0, 5);
          best.merged = (best.merged || 0) + 1;
          if (!saveVector(ctx, data)) return '语义记忆合并落盘失败：磁盘写入异常';
          return `与 #${best.id} 高度相似（余弦 ${bestS.toFixed(2)} ≥ ${COS_MERGE}），已合并为补充条目（原文保留在 #${best.id}）`;
        }
      }

      const item = { id: allocId(memFiles(ctx).vector), ts: Date.now(), content: content.slice(0, 1000), tags: tags.slice(0, 5), dense, merged: 0 };
      items.push(item);
      if (!saveVector(ctx, data)) return '语义记忆保存失败：磁盘写入异常';
      return `已存入语义记忆 #${item.id}（${note}）：${content.slice(0, 50)}...`;
    }

    // ========== recall：语义混合检索（稠密余弦 + BM25 稀疏，RRF 融合；未配置 embedding 自动降级关键词） ==========
    if (action === 'recall') {
      const query = String(args.query || '').trim();
      if (!query) throw new Error('query 为空');
      const data = loadVector(ctx);
      if (!data.items.length) return '语义记忆库为空（用 remember 写入后再检索）';

      // tags 前置过滤（缩小检索范围，对齐 Hermes metadata 过滤提速）
      const qTags = normTags(args.tags);
      const pool = qTags.length ? data.items.filter(it => (it.tags || []).some(t => qTags.includes(t))) : data.items;
      if (!pool.length) return `没有标签含 [${qTags.join(' ')}] 的语义记忆（recall 不带 tags 可全库检索）`;

      const mode = ['hybrid', 'vector', 'keyword'].includes(args.mode) ? args.mode : 'hybrid';
      const topK = Math.max(1, Math.min(Number(args.top_k) || 5, 10));
      const byId = new Map(pool.map(it => [it.id, it]));

      // 稀疏路：BM25
      let sparseRank = [];
      if (mode !== 'vector') {
        sparseRank = bm25Search(query, pool, it => `${it.content} ${(it.tags || []).join(' ')}`, 20).map(x => x.d.id);
      }
      // 稠密路：embedding 余弦（配置缺失/失败时跳过，降级关键词）
      let denseRank = [];
      let modeNote = '';
      if (mode !== 'keyword') {
        const cfgE = readEmbeddingCfg(ctx);
        if (!cfgE) {
          modeNote = mode === 'vector' ? '（未配置 embedding，vector 模式不可用，已降级关键词）' : '（未配置 embedding，已降级纯关键词检索）';
        } else {
          try {
            const [qv] = await embedQueryCached(query, cfgE);
            const q = quantize(qv);
            denseRank = pool
              .filter(it => Array.isArray(it.dense) && it.dense.length === q.length)
              .map(it => ({ id: it.id, s: cosInt8(q, it.dense) }))
              .sort((a, b) => b.s - a.s)
              .slice(0, 20)
              .filter(x => x.s > 0.1)
              .map(x => x.id);
          } catch (e) {
            modeNote = `（语义路调用失败已降级关键词：${e && e.message || e}）`;
          }
        }
      }

      const fusedIds = mode === 'keyword' || (mode === 'hybrid' && !denseRank.length && sparseRank.length)
        ? sparseRank.slice(0, topK)
        : rrfFuse([sparseRank, denseRank], topK);
      if (!fusedIds.length) {
        return `语义记忆中没有匹配「${query}」的条目${modeNote}`;
      }
      const lines = fusedIds.map(id => {
        const it = byId.get(id);
        if (!it) return '';
        const tagStr = (it.tags || []).length ? ` [${it.tags.join(' ')}]` : '';
        const vecStr = Array.isArray(it.dense) ? '语义' : '关键词';
        return `#${it.id}${tagStr} (${vecStr}) ${it.content.replace(/\n/g, ' ').slice(0, 120)}`;
      }).filter(Boolean);
      return `语义记忆匹配 ${lines.length} 条（${mode} 模式${modeNote}）：\n${lines.join('\n')}`;
    }

    // ========== delete ==========
    if (action === 'delete') {
      const id = Number(args.id);
      if (level === 'vector') {
        const data = loadVector(ctx);
        const idx = data.items.findIndex(m => m.id === id);
        if (idx < 0) return `#${id} 不存在于语义记忆`;
        data.items.splice(idx, 1);
        saveVector(ctx, data);
        return `已删除语义记忆 #${id}`;
      }
      const target = level === 'long' ? files.long : files.short;
      const arr = loadJSON(target, []);
      const idx = arr.findIndex(m => m.id === id);
      if (idx < 0) return `#${id} 不存在`;
      arr.splice(idx, 1);
      saveJSON(target, arr);
      return `已删除 #${id}`;
    }
    
    return `未知操作：${action}（支持 save/search/list/delete/consolidate/archive_save/archive_search/remember/recall）`;
  }
};
