// @name read
// @desc 读取文本文件内容（支持 offset/limit 分段与 tail 读末尾；skill:name/相对路径 协议直读技能捆绑资源）
// @essential true
const fs = require('fs');
const path = require('path');

// 技能根目录（与 skill 插件同规则）：工作区 skills/ + 项目根 skills/（全局共享）
function skillRoots(ctx) {
  const roots = [path.join(ctx.cwd, 'skills')];
  const shared = process.env.DUAL_AGENT_SKILLS_SHARED || path.join(__dirname, '..', 'skills');
  if (path.resolve(shared) !== path.resolve(roots[0])) roots.push(shared);
  return roots;
}

// skill: 协议解析：skill:<name>（SKILL.md 本体）或 skill:<name>/<技能内相对路径>
// 与 skill 插件同规则：<name> 匹配目录名或 frontmatter.name（大小写/空格不敏感），命中即解析
function resolveSkillPath(input, ctx) {
  const rest = input.slice('skill:'.length);
  const slash = rest.indexOf('/');
  const wantRaw = slash < 0 ? rest : rest.slice(0, slash);
  const rel = slash < 0 ? 'SKILL.md' : rest.slice(slash + 1);
  const want = wantRaw.trim().toLowerCase().replace(/\s+/g, '-');
  if (!want) return null;
  for (const root of skillRoots(ctx)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      let names = [d.name.toLowerCase()];
      try {
        const fm = fs.readFileSync(path.join(root, d.name, 'SKILL.md'), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const nm = fm && fm[1].match(/^name:\s*(\S+)/m);
        if (nm) names.push(nm[1].toLowerCase());
      } catch { /* 无 SKILL.md 或读失败，仅按目录名 */ }
      if (!names.includes(want)) continue;
      const candidate = path.resolve(root, d.name, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// 列出全部可用技能名（skill: 路径 miss 时给修正提示；目录名或 frontmatter.name 均可）
function listSkillNames(ctx) {
  const names = [];
  for (const root of skillRoots(ctx)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      try {
        const text = fs.readFileSync(path.join(root, d.name, 'SKILL.md'), 'utf8');
        if (!text) continue;
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const nm = fm && fm[1].match(/^name:\s*(\S+)/m);
        names.push(nm ? nm[1] : d.name);
      } catch { /* 跳过无 SKILL.md 的目录 */ }
    }
  }
  return [...new Set(names)];
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径：相对工作目录 / 绝对路径 / skill:技能名/相对路径（读技能捆绑资源，如 skill:pdf/scripts/run.py；skill:技能名 直接读其 SKILL.md）' },
      offset: { type: 'number', description: '从第几个字符开始读（默认 0，配合 limit 分段读大文件）' },
      limit: { type: 'number', description: '最多读取的字符数（默认 8000）' },
      tail: { type: 'number', description: '只读文件末尾 N 个字符（查看追加位置/结尾时用，优先于 offset）' }
    },
    required: ['path']
  },
  run: async (args, ctx) => {
    const input = String(args.path || '');
    // skill: 协议：框架级解析技能相对路径（SKILL.md 正文中的相对引用直接照抄即可读）
    let fp;
    if (/^skill:/i.test(input)) {
      fp = resolveSkillPath(input, ctx);
      if (!fp) {
        const known = listSkillNames(ctx);
        throw new Error(`skill: 路径未命中：${input}。可用技能：${known.join('、') || '（无）'}；先 skill.list() 查看，或检查技能内相对路径拼写`);
      }
    } else {
      // 工作区路径沙箱（与 write.js 逐字对齐）：进程根/工程根路径重定向回工作区，外部路径拒绝
      const __safeResolve = (cwd, p) => {
        const fp = path.resolve(cwd, String(p || ''));
        if (fp === cwd || fp.startsWith(cwd + path.sep)) return fp;
        const rel = path.relative(cwd, fp);
        for (const root of [path.resolve(cwd, '../..'), process.cwd()]) {
          if ((rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
            const r = path.relative(root, fp);
            if (r && !r.startsWith('..') && !path.isAbsolute(r)) return path.join(cwd, r);
          }
        }
        throw new Error(`路径越界：${fp} 不在工作区 ${cwd} 内。请使用工作区内相对路径，或 ${cwd}/ 前缀的绝对路径`);
      };
      fp = __safeResolve(ctx.cwd, input);
    }
    // 软失败一律 throw：框架据此标记失败并计入评审统计（返回字符串会被误读为成功）
    if (!fs.existsSync(fp)) throw new Error(`文件不存在：${fp}`);
    const st = fs.statSync(fp);
    if (st.isDirectory()) throw new Error(`${fp} 是目录，请提供具体文件路径（如 notes/todo.txt）`);
    if (st.size > 512 * 1024) throw new Error(`文件过大（${st.size} 字节），仅支持读取 512KB 以内的文本文件；大文件请用 offset/limit 分段读`);
    const content = fs.readFileSync(fp, 'utf8');
    const total = content.length;
    const lines = content.split('\n').length;
    if (args.tail !== undefined && args.tail !== null) {
      const n = Math.max(1, Math.min(Number(args.tail) || 2000, 32000));
      const start = Math.max(0, total - n);
      return `已读取 ${fp} 末尾 ${total - start}/${total} 字符（全文 ${total} 字符 ${lines} 行）：\n\n${content.slice(start)}`;
    }
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 8000), 32000));
    const slice = content.slice(offset, offset + limit);
    if (!slice) throw new Error(`offset ${offset} 超出文件长度（全文仅 ${total} 字符）`);
    const head = offset === 0 && slice.length === total
      ? `已读取 ${fp}（${total} 字符，${lines} 行）：\n\n`
      : `已读取 ${fp} 第 ${offset}-${offset + slice.length}/${total} 字符（未读完整，继续读用 offset=${offset + slice.length}）：\n\n`;
    return head + slice;
  }
};
