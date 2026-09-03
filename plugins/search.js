// @name search
// @desc 联网搜索并返回结果列表（标题+URL+摘要；AnySearch 匿名通道优先，多引擎评分择优，配 DUAL_AGENT_SEARCH_KEY 后优先走 Serper）
// @essential false
// 设计参考 agent-reach 的免 key 哲学 + anysearch skill 的匿名/key 池机制：
// AnySearch API 匿名可用，402 配额耗尽时响应体自动发放 api_key（存本地轮换复用）；
// 无任何 key 时走公开通道评分择优（AnySearch → Bing → 百度 → DDG）；本插件只负责"搜索"。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const ANYSEARCH_API = 'https://api.anysearch.com/v1/search';
const ANYSEARCH_KEYS_FILE = 'anysearch-keys.json'; // 存 dataDir（.data 已 gitignore）

function decodeEnt(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } }) // 数字实体（&#174;=® 等）
    .replace(/\s+/g, ' ').trim();
}
async function httpGet(url, headers, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await fetch(url, { signal: ac.signal, redirect: 'follow', headers });
    return { status: resp.status, body: await resp.text() };
  } finally { clearTimeout(timer); }
}
async function httpPostJson(url, body, headers, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const resp = await fetch(url, { method: 'POST', signal: ac.signal, headers, body: JSON.stringify(body) });
    const text = await resp.text();
    return { status: resp.status, body: text };
  } finally { clearTimeout(timer); }
}

// ---------- 引擎 0：AnySearch（匿名免费通道，v0.9.11 借鉴 anysearch skill） ----------
// 实测（2026-08）：匿名直连 200，中英文长尾查询质量高（直接命中真信源）；
// 配额耗尽（402）时响应体自动发放新 api_key——提取存本地 key 池轮换复用。
// key 池：dataDir/anysearch-keys.json，[{key,status:active|exhausted,call_count,...}]
// 环境变量 DUAL_AGENT_ANYSEARCH_KEY 可手动注入。key 值永不写入日志/返回文本。
let _asKeysCache = null; // { mtime, keys } 进程内缓存
function anysearchLoadKeys(dataDir) {
  if (!dataDir) return [];
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(dataDir, ANYSEARCH_KEYS_FILE);
    const st = fs.statSync(f);
    if (_asKeysCache && _asKeysCache.mtime === st.mtimeMs) return _asKeysCache.keys;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const keys = Array.isArray(j.keys) ? j.keys.filter(k => k && k.key && k.status !== 'exhausted') : [];
    _asKeysCache = { mtime: st.mtimeMs, keys };
    return keys;
  } catch { return []; }
}
function anysearchSaveKey(dataDir, newKey) {
  if (!dataDir || !/^as_/.test(String(newKey || ''))) return; // 只存 anysearch 形态的 key
  try {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(dataDir, ANYSEARCH_KEYS_FILE);
    let j = { keys: [] };
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* 首次 */ }
    if (!Array.isArray(j.keys)) j.keys = [];
    if (j.keys.some(k => k.key === newKey)) return; // 去重
    j.keys.push({ key: newKey, status: 'active', source: 'auto_402', added_at: new Date().toISOString(), call_count: 0 });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify(j, null, 1));
    try { fs.chmodSync(f, 0o600); } catch { /* 非 POSIX */ }
    _asKeysCache = null; // 失效缓存
  } catch { /* key 持久化失败不阻断搜索 */ }
}
function extractIssuedKey(body) {
  try {
    const j = JSON.parse(body);
    return j.api_key || (j.credentials || {}).api_key || (j.data || {}).api_key || '';
  } catch { return ''; }
}
async function anysearchEngine(query, count, ctx) {
  const dataDir = ctx && ctx.dataDir;
  const pool = [
    ...anysearchLoadKeys(dataDir),
    ...(process.env.DUAL_AGENT_ANYSEARCH_KEY ? [{ key: process.env.DUAL_AGENT_ANYSEARCH_KEY }] : [])
  ];
  const attempts = pool.length ? pool.map(k => k.key) : [null]; // 有 key 先用，匿名兜底
  for (const key of [...attempts, null]) { // 末尾再补一次匿名（key 全挂时兜底）
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'AnySearch-Skill/1.0' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await httpPostJson(ANYSEARCH_API, { query, max_results: Math.max(count, 5) }, headers, 12000);
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const data = j.data || j;
        const items = (data.results || data.items || []).filter(x => x && (x.title || x.url));
        if (!items.length) return null;
        return items.slice(0, count).map(x => ({
          title: String(x.title || '').trim(),
          url: String(x.url || x.link || '').trim(),
          snippet: String(x.description || x.content || x.snippet || '').trim().slice(0, 300)
        }));
      } catch { return null; }
    }
    if (r.status === 402 || r.status === 401 || r.status === 429) {
      const issued = extractIssuedKey(r.body); // 402 自动发放：提取存池，下轮 attempts 已覆盖不到则下次生效
      if (issued) anysearchSaveKey(dataDir, issued);
      continue; // 换下一个 key / 匿名重试
    }
    return null; // 其他状态码（5xx/网络）：本引擎放弃，交由后续引擎
  }
  return null;
}

// ---------- 引擎 1：Serper（可选 key 升级通道；Google 官方结果质量最高） ----------
async function serperEngine(query, count) {
  const key = process.env.DUAL_AGENT_SEARCH_KEY;
  if (!key) return null; // 未配置 key：跳过，走免 key 通道
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST', signal: ac.signal,
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: count, hl: 'zh-cn' })
    });
    if (!resp.ok) return null; // key 失效/配额尽：静默降级到免 key 通道
    const j = await resp.json();
    return (j.organic || []).slice(0, count).map(r => ({
      title: r.title, url: r.link, snippet: r.snippet || ''
    }));
  } catch { return null; } finally { clearTimeout(timer); }
}

// ---------- 引擎 2：Bing 网页版（免 key，实测连通性最好） ----------
// v0.9.9：链接解包（ck/a 跳转包装）+ h2→a 桥接正则（ensearch 变体里 href 前有 target 属性）
function unwrapBing(u) {
  const m = /[?&]u=a1([^&]+)/.exec(u);
  if (m) { try { return Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8'); } catch { return u; } }
  return u;
}
async function bingEngine(query, count) {
  const r = await httpGet(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(count, 10)}&setlang=zh-hans`,
    { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' }, 12000);
  if (r.status !== 200) return null;
  const out = [];
  const blocks = r.body.split(/class="b_algo"/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>[\s\S]{0,200}?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const url = unwrapBing(m[1].replace(/&amp;/g, '&'));
    if (/bing\.com|microsoft\.com\/bing/i.test(url)) continue;
    const sm = b.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      || b.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({ title: decodeEnt(m[2]), url, snippet: decodeEnt(sm ? sm[1] : '') });
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

// ---------- 引擎 3：百度（免 key；中文分词质量最好，但连续请求会触发安全验证 → 仅靠择优链兜底） ----------
// v0.9.9 真实调研病根：Bing 对中文长尾查询分词降级返回百科词条，百度同查询直接命中
// 「我国日均 Token 调用量突破 140 万亿」。链接是 baidu.com/link 跳转包装（fetch 跟随重定向可到真实页）。
async function baiduEngine(query, count) {
  const r = await httpGet(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.max(count, 10)}`,
    { 'User-Agent': UA, 'Referer': 'https://www.baidu.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' }, 12000);
  if (r.status !== 200 || /百度安全验证|wappass/.test(r.body)) return null; // 验证页视为不可用
  const out = [];
  const blocks = r.body.split(/<div[^>]*class="result[^"]*c-container[^"]*"/).slice(1);
  for (const b of blocks) {
    const m = b.match(/<h3[^>]*>[\s\S]{0,200}?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const sm = b.match(/class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/)
      || b.match(/<span class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    out.push({ title: decodeEnt(m[2]), url: m[1], snippet: decodeEnt(sm ? sm[1] : '') });
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

// ---------- 引擎 3：DuckDuckGo HTML 版（免 key 备用；部分地区网络不可达，失败自动跳过） ----------
async function ddgEngine(query, count) {
  const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { 'User-Agent': UA }, 10000);
  if (r.status !== 200) return null;
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(r.body))) {
    let url = m[1];
    const u = url.match(/[?&]uddg=([^&]+)/); // DDG 跳转链接解包真实 URL
    if (u) { try { url = decodeURIComponent(u[1]); } catch { /* 保留原样 */ } }
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ title: decodeEnt(m[2]), url, snippet: decodeEnt(m[3]) });
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

// ---------- 结果相关性评分（v0.9.9 病根修复：引擎链按"可用性"降级 → 按"质量"择优） ----------
// 病根：Bing 免 key 网页版对长尾中文查询做分词降级（搜「中国 大模型 token调用量」返回
// 「中华人民共和国_百度百科」），解析成功即短路了 DDG——而 DDG 对同查询返回真信源。
// 评分：query 切 term（≥2 字符），统计 term 在 title+snippet 的子串命中率，归一化 0-1。
function scoreResults(query, results) {
  const terms = String(query).split(/[\s,，、;；]+/).map(t => t.trim()).filter(t => t.length >= 2);
  if (!terms.length || !results.length) return 0;
  let hit = 0;
  for (const t of terms) {
    if (results.some(r => (String(r.title) + ' ' + String(r.snippet)).toLowerCase().includes(t.toLowerCase()))) hit += 1;
  }
  return hit / terms.length;
}

const QUALITY_THRESHOLD = 0.3; // 结果集平均 term 命中率低于此值视为低质量（触发备选引擎对比）
// 垃圾域名特征：词典/百科/政府门户类站点对技术调研无信息量（分词降级的主要受害者）
const JUNK_DOMAIN_RE = /baike\.baidu\.com|\.gov\.cn|zhuanlan\.zhihu\.com\/p\/\d+$|wenku\.baidu\.com/i;

function engineScore(query, results) {
  if (!results || !results.length) return 0;
  const base = scoreResults(query, results);
  const junkRatio = results.filter(r => JUNK_DOMAIN_RE.test(r.url)).length / results.length;
  return Math.max(0, base - junkRatio * 0.5); // 垃圾域名占比惩罚
}

// 低质量结果时的策略建议（v0.9.9：治"20 次同质搜索循环"——给模型可执行的换路指令）
const LOW_QUALITY_ADVICE = [
  '⚠ 本次结果相关性低（引擎可能对查询做了分词降级）。建议下一步任选其一：',
  '1) 用 fetch 打开上面最相关的 1-2 条结果验证内容（摘要常缺数据，正文才有）；',
  '2) 换英文关键词重搜（技术统计英文信源多）；3) 直取权威信源（官方博客/行业报告页）而非泛搜。'
].join('\n');

module.exports = {
  scoreResults, engineScore, QUALITY_THRESHOLD,
  params: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（中英文均可）' },
      count: { type: 'number', description: '返回结果条数，默认 5（最大 10）' }
    },
    required: ['query']
  },
  run: async (args, ctx) => {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query 为空：请提供搜索关键词');
    const count = Math.min(10, Math.max(1, Number(args.count) || 5));
    // 引擎链（v0.9.11）：Serper（有 key，Google 结果）→ AnySearch（匿名免费，中英文质量高）
    // → Bing → 百度 → DDG。
    // 择优逻辑（v0.9.9）：引擎返回后先评分，低于阈值不短路——继续跑备选引擎，
    // 取分数高者返回；首引擎质量达标则与旧版行为一致（省请求）。
    // AnySearch 匿名直连实测质量优于所有爬虫引擎，放免 key 链首
    const chain = [
      ['serper', (q, c) => serperEngine(q, c)],
      ['anysearch', (q, c) => anysearchEngine(q, c, ctx)],
      ['bing', (q, c) => bingEngine(q, c)],
      ['baidu', (q, c) => baiduEngine(q, c)],
      ['duckduckgo', (q, c) => ddgEngine(q, c)]
    ];
    const errors = [];
    let best = null; // { name, results, score }
    for (const [name, fn] of chain) {
      let results;
      try { results = await fn(query, count); }
      catch (e) { errors.push(`${name}: ${String((e && e.message) || e).slice(0, 80)}`); continue; }
      if (!results || !results.length) continue;
      const score = engineScore(query, results);
      if (!best || score > best.score) best = { name, results, score };
      if (score >= QUALITY_THRESHOLD) break; // 质量达标即短路（与旧版一致）
    }
    if (best) {
      const lines = best.results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 150)}` : ''}`);
      const head = `搜索「${query}」via ${best.name}（相关性 ${best.score.toFixed(2)}），${best.results.length} 条结果：`;
      const tail = best.score < QUALITY_THRESHOLD
        ? `\n\n${LOW_QUALITY_ADVICE}`
        : '\n\n需要看某个网页的完整内容时，用 fetch(url=...) 打开对应链接。';
      return `${head}\n\n${lines.join('\n\n')}${tail}`;
    }
    throw new Error(`所有搜索引擎均不可用（${errors.join('；') || '网络出口受限'}）。` +
      `请稍后重试，或改用 fetch 直接抓取已知网址；本机可配置 DUAL_AGENT_SEARCH_KEY（serper.dev 免费 key）启用 Google 正式通道。`);
  }
};
