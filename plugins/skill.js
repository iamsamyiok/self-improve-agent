// @name skill
// @desc 技能库（兼容 Agent Skills 开放标准）：list 列出（仅名称+描述，渐进式）/ get 读全文 / save 沉淀 / delete 删除。支持目录型 skills/<name>/SKILL.md 与单文件 skills/<name>.md，社区技能直接拷入即用
// @essential false
const fs = require('fs');
const path = require('path');

// 技能名支持中英文（单文件旧格式）
const NAME_RE = /^[a-zA-Z0-9\u4e00-\u9fa5-]{1,64}$/;
// Agent Skills 标准名（目录型）：小写字母/数字/连字符，无连续连字符
const STD_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// 技能搜索根：工作区 skills/ 优先，项目根 skills/ 全局共享（社区技能统一放这里，所有工作区可用）
// __dirname = <root>/plugins，故 .. 即项目根；DUAL_AGENT_SKILLS_SHARED 可覆盖（测试隔离）
function skillRoots(ctx) {
  const roots = [path.join(ctx.cwd, 'skills')];
  const shared = process.env.DUAL_AGENT_SKILLS_SHARED || path.join(__dirname, '..', 'skills');
  if (path.resolve(shared) !== path.resolve(roots[0])) roots.push(shared);
  return roots;
}

function toSlug(name) {
  return name.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 64);
}

// 解析 SKILL.md 的 YAML frontmatter（name/description 等简单键值；无需完整 YAML 实现）
// 兼容社区技能常见多行写法（Agent Skills 规范允许 YAML 折叠标量）：
// - 块标量 description: >- / > / | / |-（后续更缩进行为值）
// - 普通标量续行（下一行以空格开头则并入）
function parseFrontmatter(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kv) continue; // 列表项（- xxx）与嵌套结构不支持（本系统用不到）
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      // 块标量：收集比键更深缩进的连续行；首行缩进决定剥离量
      const keyIndent = line.length - line.replace(/^\s+/, '').length;
      const block = [];
      let blockIndent = -1;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) { block.push(''); j++; continue; }
        const ind = l.length - l.replace(/^\s+/, '').length;
        if (ind <= keyIndent) break;
        if (blockIndent < 0) blockIndent = ind;
        block.push(l.slice(Math.min(blockIndent, l.length)));
        j++;
      }
      i = j - 1;
      if (val.startsWith('>')) {
        // 折叠标量：换行折成空格（忽略 chomping 细节，本场景足够）
        val = block.join(' ').replace(/\s+/g, ' ').trim();
      } else {
        val = block.join('\n').replace(/\n+$/, ''); // 字面量：保留换行
      }
    } else if (val) {
      // 普通标量续行：后续更缩进行并入（YAML 多行 plain scalar）
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l || !/^\s+\S/.test(l)) break;
        val += ' ' + l.trim();
        j++;
      }
      i = j - 1;
    }
    fm[key] = val.replace(/^["']|["']$/g, '').trim();
  }
  return Object.keys(fm).length ? fm : null;
}

// 描述截断：优先在词/句边界断开并加省略号，避免截在词中间
function clipDesc(s, max = 160) {
  const str = String(s || '').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('、'));
  return (boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd() + '…';
}

// 扫描一个根下的全部技能：目录型（含 SKILL.md）+ 单文件型
// 垃圾文档判定：SKILL.md 实为误存的网页 HTML（scout 安装/手工保存偶发）——
// 无 frontmatter 且首个非空行是 HTML 文档标签。这类「技能」会把 DOCTYPE/标签当描述
// 注入系统提示词与快照，污染 LLM 上下文，必须在扫描层整条跳过。
function looksLikeHtmlDoc(text) {
  const first = String(text || '').split('\n').map(l => l.trim()).find(l => l) || '';
  return /^<!doctype/i.test(first) || /^<html[\s>]/i.test(first);
}

// 返回 [{ name, desc, kind: 'dir'|'file', dir, entry }]；目录型 name 取 frontmatter.name（回退目录名）
function scanRoot(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      const entry = path.join(dir, e.name, 'SKILL.md');
      if (!fs.existsSync(entry)) continue;
      let name = e.name;
      let desc = '';
      try {
        const text = fs.readFileSync(entry, 'utf8');
        if (looksLikeHtmlDoc(text)) continue; // 误存网页 HTML：整条跳过（不进清单、不进系统提示词）
        const fm = parseFrontmatter(text);
        if (fm && fm.name && STD_NAME_RE.test(fm.name)) name = fm.name;
        if (fm && fm.description) desc = fm.description;
        if (!desc) desc = text.split('\n').find(l => l.trim() && !l.startsWith('---')).replace(/^#+\s*/, '').slice(0, 120);
      } catch { /* 读失败按目录名列出 */ }
      out.push({ name, desc: clipDesc(desc), kind: 'dir', dir, entry });
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const name = e.name.replace(/\.md$/, '');
      let head = '';
      try {
        const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
        if (looksLikeHtmlDoc(text)) continue;
        const fm = parseFrontmatter(text); // 单文件也兼容 frontmatter（description 优先）
        head = (fm && fm.description) || text.split('\n').find(l => l.trim() && !l.startsWith('---')).replace(/^#+\s*/, '');
      } catch { /* ignore */ }
      out.push({ name, desc: clipDesc(head), kind: 'file', dir, entry: path.join(dir, e.name) });
    }
  }
  return out;
}

// 全根合并去重：先扫到者赢——roots[0] 是工作区，故工作区覆盖全局共享（同名技能就近优先）
function listAll(ctx) {
  const merged = new Map();
  skillRoots(ctx).forEach((root, idx) => {
    for (const s of scanRoot(root)) {
      const key = s.name;
      // srcTag：展示用来源标签（roots[0] 工作区 / 其余内置共享库），与 root 路径解耦
      if (!merged.has(key)) merged.set(key, { ...s, root, srcTag: idx === 0 ? 'workspace' : 'builtin' });
    }
  });
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// 渐进披露第 1 层（Agent Skills 标准）：把"名称+描述"清单注入系统提示，Agent 启动即感知。
// 返回拼好的提示文本段（纯 JS，零 LLM 工具调用轮次）；技能库为空返回空串（省略该段）。
// 截断三规则：单条 desc ≤120 字符；技能数 >40 取前 40；清单总字符 >6000 从尾部丢弃（保底 10 个）。
const PROMPT_MAX_SKILLS = 40;
const PROMPT_MAX_CHARS = 6000;
const PROMPT_MIN_SKILLS = 10;
function promptSection(ctx) {
  let all = listAll(ctx);
  if (!all.length) return '';
  all = all.map(s => ({ name: s.name, desc: String(s.desc || '').slice(0, 120) + (String(s.desc || '').length > 120 ? '…' : '') }));
  let hidden = 0;
  if (all.length > PROMPT_MAX_SKILLS) { hidden = all.length - PROMPT_MAX_SKILLS; all = all.slice(0, PROMPT_MAX_SKILLS); }
  const header = `## 可用技能库（共 ${all.length + hidden} 个）：`;
  let rows = all.map(s => `- ${s.name}: ${s.desc}`);
  const tail = '技能触发纪律：上述清单中 description 与当前任务场景匹配的技能，必须先 skill.get("<技能名>") 读全文，并严格按其步骤执行后再开始相关操作。全文引用的捆绑文件用 read 插件 path="skill:<技能名>/<相对路径>" 读取。任务中途需要再次查找时用 skill.list()。';
  const section = () => [header, ...rows, '', tail + (hidden ? `（另有 ${hidden} 个技能未列出，可用 skill.list() 查看）` : '')].join('\n');
  while (section().length > PROMPT_MAX_CHARS && rows.length > PROMPT_MIN_SKILLS) {
    hidden += 1;
    rows = rows.slice(0, -1);
   }
   return section();
 }

// ---------- 技能预取匹配（框架预取第 4 路：任务文本 → 主动推送可能匹配的技能） ----------
// 与清单被动注入（promptSection）互补：清单按字母序截断（>40 隐藏尾部）+ 模型不一定自觉对照清单，
// 会导致明显匹配的技能被跳过（2026-09-04 深度调研任务实证：web-research 在清单中却未被使用）。
// 预取按任务描述对全量技能库打分（不受清单截断影响），命中即在任务开始时提示先 skill.get 再动手。
// 匹配面覆盖中英混合场景：中文技能描述直接按 2-gram 相交；英文描述靠中→英提示词桥接（调研→research）。
const SKILL_MATCH_STOP = new Set(('the and for with this that use using when user users need needs want please help then their have has ' +
  '创建 使用 需要 可以 进行 这个 任务 文件 生成 添加 修改 删除 查看 一下 相关 内容 信息 操作 执行 处理 支持 实现 提供 返回 输出 包含 基于 通过 如果 或者 以及').split(/\s+/));
const SKILL_MATCH_ZH_EN = {
  '调研': 'research', '研究': 'research', '搜索': 'search', '检索': 'search', '报告': 'report', '文档': 'document',
  '代码': 'code', '调试': 'debug', '测试': 'test', '写作': 'writing', '撰写': 'writing', '翻译': 'translate',
  '图像': 'image', '视频': 'video', '数据': 'data', '网页': 'web', '前端': 'frontend', '后端': 'backend',
  '计划': 'plan', '规划': 'plan', '头脑风暴': 'brainstorm', '评审': 'review', '审查': 'review', '分析': 'analysis', '部署': 'deploy'
};
function skillMatchTokens(text) {
  const s = String(text || '');
  const grams = new Set();
  const enWords = (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter(w => !SKILL_MATCH_STOP.has(w));
  for (const w of enWords) grams.add(w);
  const zhRuns = s.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zhRuns) {
    for (const [zh, en] of Object.entries(SKILL_MATCH_ZH_EN)) if (run.includes(zh)) grams.add(en);
    if (run.length <= 4) { grams.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) { // 长串切 2-gram，避免整串匹配过严
      const g = run.slice(i, i + 2);
      if (!SKILL_MATCH_STOP.has(g)) grams.add(g);
    }
  }
  return [...grams];
}
function matchSkills(ctx, text, topN) {
  const grams = skillMatchTokens(text);
  if (!grams.length) return [];
  const gset = new Set(grams);
  const bridgeValues = new Set(Object.values(SKILL_MATCH_ZH_EN)); // 中英桥接词 = 核心意图词，name/desc 同权重
  const scored = [];
  for (const s of listAll(ctx)) {
    const nameHay = String(s.name || '').toLowerCase();
    const descHay = String(s.desc || '').toLowerCase();
    let score = 0;
    for (const g of gset) {
      const strong = bridgeValues.has(g);
      if (nameHay.includes(g)) score += strong ? 3 : 2; // 技能名命中权重高（最直接的场景对应）
      else if (descHay.includes(g)) score += strong ? 2 : 1;
    }
    if (score >= 2) scored.push({ name: s.name, desc: String(s.desc || ''), score });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, Math.max(1, topN || 3));
}

function findBySlug(ctx, name) {
  const slug = toSlug(name);
  return listAll(ctx).find(s => s.name === name || s.name === slug);
}

// ---------- GitHub 一键安装 ----------
// 源格式解析：owner/repo | owner/repo/sub/dir | https://github.com/owner/repo[/tree/branch/sub/dir]
// 返回 { owner, repo, branch, subdir }（subdir 为仓库内技能目录路径，可空 = 根即技能）
function parseGitHubSource(src) {
  let m = String(src).trim().replace(/\.git$/, '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(\/.*)?)?\/?$/i);
  let owner, repo, branch, subdir;
  if (m) {
    owner = m[1]; repo = m[2]; branch = m[3] || ''; subdir = (m[4] || '').replace(/^\/+/, '');
  } else {
    m = String(src).trim().match(/^([\w.-]+)\/([\w.-]+)(\/.*)?$/);
    if (!m) throw new Error(`无法解析 GitHub 源：${src}（支持 owner/repo、owner/repo/子目录、完整 URL）`);
    owner = m[1]; repo = m[2]; subdir = (m[3] || '').replace(/^\/+|\/+$/g, '');
  }
  return { owner, repo, branch, subdir };
}

// tar.gz 内存解包：只依赖 zlib，按 POSIX ustar 头解析（GitHub tarball 足够）
// 返回 Map<路径, Buffer>（跳过 pax_global_header 与目录条目）
function untar(gzBuf) {
  const zlib = require('zlib');
  const buf = zlib.gunzipSync(gzBuf);
  const files = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.slice(off, off + 512);
    if (!header.some(b => b !== 0)) break; // 全零块 = 结束
    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeStr = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = header.toString('utf8', 156, 157);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if (type === '0' || type === '') files.set(full, buf.slice(off, off + size)); // 仅普通文件
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

// 安装到全局共享根（所有工作区可用）；记录版本信息 skills/.installed.json
async function installFromGitHub(src, ctx) {
  const { owner, repo, branch, subdir } = parseGitHubSource(src);
  const root = process.env.DUAL_AGENT_SKILLS_SHARED || path.join(__dirname, '..', 'skills');
  fs.mkdirSync(root, { recursive: true });

  // 默认分支解析：GitHub API（匿名限额 60/h 够用）；失败回退 HEAD
  let br = branch;
  let defaultBranchTip = '';
  if (!br) {
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { 'User-Agent': 'dual-agent' } });
      if (r.ok) {
        const meta = await r.json();
        br = meta.default_branch || 'main';
      } else if (r.status === 404) {
        throw new Error(`仓库不存在或不可访问：${owner}/${repo}`);
      } else { br = 'HEAD'; }
    } catch (e) { if (e.message && e.message.includes('仓库不存在')) throw e; br = 'HEAD'; }
  }
  const ref = br === 'HEAD' ? 'HEAD' : br;
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
  const resp = await fetch(tarUrl, { headers: { 'User-Agent': 'dual-agent' } });
  if (!resp.ok) throw new Error(`下载失败（HTTP ${resp.status}）：${tarUrl}`);
  const tarball = Buffer.from(await resp.arrayBuffer());
  let files;
  try { files = untar(tarball); } catch (e) { throw new Error(`tarball 解包失败：${e.message}`); }
  if (!files.size) throw new Error('tarball 为空');

  // tar 根前缀（<repo>-<branch>/）；目标：subdir 下含 SKILL.md 的技能目录
  const firstKey = files.keys().next().value;
  const prefix = firstKey.slice(0, firstKey.indexOf('/') + 1);
  const strip = p => p.startsWith(prefix) ? p.slice(prefix.length) : p;
  const candidates = new Map(); // 技能目录名 -> { [rel]: Buffer }
  const sub = subdir ? subdir.replace(/\/+$/, '') + '/' : '';
  const subLeaf = subdir ? subdir.split('/').filter(Boolean).pop() : ''; // subdir 末段（subdir 直指技能目录时的技能名）
  // 判定 subdir 语义：subdir 根有 SKILL.md = 直接指向技能目录（全部归一）；否则 subdir 下每个含 SKILL.md 的子目录是一个技能
  const subdirIsSkill = sub && [...files.keys()].some(k => strip(k) === `${sub}SKILL.md`);
  for (const [k, v] of files) {
    const rel = strip(k);
    if (sub) {
      if (!rel.startsWith(sub)) continue;
      const rest = rel.slice(sub.length);
      if (!rest) continue;
      const top = subdirIsSkill ? subLeaf : rest.split('/')[0];
      if (!top) continue;
      if (!candidates.has(top)) candidates.set(top, new Map());
      const inner = subdirIsSkill ? rest : rest.slice(top.length + 1);
      if (inner) candidates.get(top).set(inner, v);
    } else {
      const parts = rel.split('/');
      if (parts.length < 2) continue; // 仓库根散文件不算技能
      const top = parts[0];
      if (!candidates.has(top)) candidates.set(top, new Map());
      candidates.get(top).set(parts.slice(1).join('/'), v);
    }
  }
  // 过滤：必须含 SKILL.md
  let toInstall = [];
  for (const [dirName, fmap] of candidates) {
    if (fmap.has('SKILL.md')) toInstall.push({ name: dirName, files: fmap });
  }
  if (!toInstall.length) {
    throw new Error(`未在 ${owner}/${repo}${subdir ? `/${subdir}` : ''} 中找到任何含 SKILL.md 的技能目录（Agent Skills 标准）。若技能在子目录，试试 url=owner/repo/skills/<name>`);
  }
  // 上限保护
  if (toInstall.length > 30) toInstall = toInstall.slice(0, 30);

  // 版本记录（幂等重装 = 更新）
  const metaPath = path.join(root, '.installed.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* ignore */ }
  // 既有注册名 → 目录名映射（安装前快照）：stdName 已被其他目录占用时跳过该技能，
  // 避免 listAll 按 name 去重隐藏后来者（同名目录 frontmatter name 相同的场景，2026-09-04 实证）
  const existingNames = new Map();
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    let nm = d.name;
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(root, d.name, 'SKILL.md'), 'utf8'));
      if (fm && fm.name && STD_NAME_RE.test(fm.name)) nm = fm.name;
    } catch { /* 读失败用目录名 */ }
    if (!existingNames.has(nm)) existingNames.set(nm, d.name);
  }
  const installed = [], conflicts = [];
  const taken = new Set(); // 本批次内 stdName 互斥
  for (const it of toInstall) {
    const safeName = it.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-');
    let stdName = safeName;
    try {
      const fm = parseFrontmatter(it.files.get('SKILL.md').toString('utf8'));
      if (fm && fm.name && STD_NAME_RE.test(fm.name)) stdName = fm.name;
    } catch { /* ignore */ }
    const holder = existingNames.get(stdName);
    if (holder && holder !== safeName) { conflicts.push(`${stdName}（已被技能目录 ${holder} 占用）`); continue; }
    if (taken.has(stdName)) { conflicts.push(`${stdName}（本次安装源内重名：${safeName}）`); continue; }
    taken.add(stdName);
    const dest = path.join(root, safeName);
    // 防路径逃逸与覆盖无关目录：目标已存在但无 SKILL.md 则拒绝
    if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, 'SKILL.md'))) {
      throw new Error(`目标目录已存在且不是技能目录，拒绝覆盖：${dest}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    let n = 0, bytes = 0;
    for (const [rel, content] of it.files) {
      const target = path.join(dest, rel);
      if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) continue; // 防逃逸
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      n++; bytes += content.length;
    }
    meta[stdName] = { source: `github:${owner}/${repo}`, ref: br, dir: safeName, files: n, bytes, installedAt: new Date().toISOString() };
    installed.push(`${stdName}（${n} 个文件，${(bytes / 1024).toFixed(0)}KB）`);
  }
  try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch { /* 记录失败不阻塞 */ }
  let note = '';
  if (conflicts.length) note = `\n\n⚠ 以下 ${conflicts.length} 个技能因注册名冲突被跳过（同名技能已存在，避免清单去重后互相隐藏）：\n- ${conflicts.join('\n- ')}`;
  return `已从 github.com/${owner}/${repo}（${br}）安装 ${installed.length} 个技能到共享技能库：\n${installed.join('\n') || '（无）'}\n用 skill.list() 查看，get(名) 读全文后按其指引执行。${note}`;
}


module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'save', 'delete', 'install'], description: '操作：list 列出 / get 读全文 / save 保存 / delete 删除 / install 从 GitHub 一键安装' },
      name: { type: 'string', description: '技能名（list/get/save/delete 用；install 时为 GitHub 源，见 url 参数）' },
      content: { type: 'string', description: 'save 必填：技能全文（markdown；建议 YAML frontmatter 含 name/description）' },
      url: { type: 'string', description: 'install 必填：GitHub 源。支持三种格式——仓库简写 owner/repo、带子目录 owner/repo/path/to/skill、完整 URL https://github.com/owner/repo（可选 /tree/branch/subdir）' }
    },
    required: ['action']
  },

  run: async (args, ctx) => {
    const action = args.action;

    // ========== list：渐进式第一级——只给名称+描述（≈100 token/技能） ==========
    if (action === 'list') {
      const all = listAll(ctx);
      if (!all.length) {
        return '技能库为空。社区技能（Agent Skills 标准：含 SKILL.md 的目录）直接拷入 skills/ 或 <项目根>/skills/ 即可被识别；完成任务后也可用 save 沉淀自己的方法';
      }
      const lines = all.map(s => `- ${s.name}：${s.desc || '（无描述）'}${s.kind === 'dir' ? '' : ''}`);
      return `共 ${all.length} 个技能（get(name) 读全文后按其指引执行）：\n${lines.join('\n')}`;
    }

    const name = String(args.name || '').trim();
    const found = action === 'install' ? null : findBySlug(ctx, name);

    // ========== install：从 GitHub 一键安装（tarball 拉取 + 内存解包，零依赖） ==========
    if (action === 'install') {
      const src = String(args.url || args.name || '').trim();
      if (!src) throw new Error('install 需要 url 参数（owner/repo 或完整 GitHub URL）');
      return await installFromGitHub(src, ctx);
    }

    // ========== save：保存为单文件格式（工作区 skills/<slug>.md） ==========
    if (action === 'save') {
      const content = String(args.content || '').trim();
      if (!content) throw new Error('content 为空');
      if (!NAME_RE.test(name)) {
        throw new Error(`技能名不合法（限 1-64 位字母/数字/中文/连字符）：${name}`);
      }
      const slug = toSlug(name);
      const fp = path.join(ctx.cwd, 'skills', `${slug}.md`);
      // 注册名冲突校验：同工作区已有一个同名技能（目录型）指向其他文件时拒绝保存，
      // 否则 listAll 按 name 去重会隐藏其中之一，skill:get 无法可靠命中（2026-09-04 深度调研重名实证）
      const dup = findBySlug(ctx, name);
      if (dup && dup.entry !== fp && path.resolve(dup.root) === path.resolve(ctx.cwd, 'skills')) {
        throw new Error(`技能名 ${name} 已被同工作区的 ${path.basename(dup.entry)} 占用（注册名冲突），请换名或先 delete 旧技能`);
      }
      const existed = fs.existsSync(fp);
      fs.mkdirSync(path.join(ctx.cwd, 'skills'), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      return `${existed ? '已更新' : '已保存'}技能 ${name}（${content.length} 字符）`;
    }

    if (!found) {
      throw new Error(`技能 ${name} 不存在，可先 action=list 查看已有技能`);
    }

    // ========== get：渐进式第二级——载入全文（SKILL.md 或单文件） ==========
    if (action === 'get') {
      const text = fs.readFileSync(found.entry, 'utf8');
      let resDir = '';
      if (found.kind === 'dir') {
        // 框架自动扫描捆绑资源，生成可直接照抄的 skill: 路径清单（把"按正文引用读文件"变成具体行动项）
        // 每行同时给绝对路径：bash 执行脚本（python3/node/sh）时用 → 后的路径（bash 无法解析 skill: 协议）
        const skillDir = path.dirname(found.entry);
        const files = [];
        (function walk(dir, rel) {
          let entries = [];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name === 'SKILL.md' || e.name.startsWith('.') || e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
            const p2 = path.join(dir, e.name);
            const r2 = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(p2, r2);
            else files.push({ rel: r2, abs: p2, size: fs.statSync(p2).size });
          }
        })(skillDir, '');
        const list = files.map(f => `  - skill:${found.name}/${f.rel} → ${f.abs}（${f.size} 字节）`).join('\n');
        resDir = `【目录型技能】捆绑资源清单（read 用 skill: 前缀；bash 执行用 → 后的绝对路径；正文引用其中文件时必须先读再用，禁止跳过或凭空自造替代）：\n${list || '  （无捆绑文件）'}\n\n`;
      }
      return `${resDir}${text}`;
    }

    // ========== delete：单文件直接删；目录型整目录删（含捆绑资源） ==========
    if (action === 'delete') {
      if (found.kind === 'file') {
        fs.unlinkSync(found.entry);
        return `已删除技能 ${found.name}`;
      }
      fs.rmSync(path.dirname(found.entry), { recursive: true, force: true });
      return `已删除目录型技能 ${found.name}（含捆绑资源）`;
    }

    throw new Error(`未知操作：${action}（支持 list/get/save/delete）`);
  }
};
module.exports.promptSection = promptSection;
module.exports.matchSkills = matchSkills;
module.exports.skillMatchTokens = skillMatchTokens;
module.exports.listAll = listAll;
