// @name stat
// @desc 文件客观统计（零 token）：字符数/CJK 字数/行数/字节/修改时间；支持 glob 多文件分组汇总。交付核验字数用它，禁止信任模型自报
// @essential false
const fs = require('fs');
const path = require('path');

// CJK 字符计数（中日韩 + 全角标点）——长文任务的"字数"口径
function cjkCount(s) {
  let n = 0;
  for (const ch of String(s || '')) if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) n++;
  return n;
}

// 单文件统计
function statFile(fp) {
  const content = fs.readFileSync(fp, 'utf8');
  const st = fs.statSync(fp);
  const lines = content.length ? (content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length) : 0;
  return {
    path: path.relative(process.cwd(), fp) === String(fp) ? fp : fp,
    chars: content.length,
    cjk: cjkCount(content),
    lines,
    words: content.split(/[\s]+/).filter(Boolean).length,
    bytes: st.size,
    mtime: new Date(st.mtimeMs).toISOString().slice(0, 19).replace('T', ' ')
  };
}

// 简易 glob：* 单段通配 / ** 递归 / 后缀匹配（覆盖 90% 场景，够用优先）
function globMatch(relPath, pattern) {
  // **/ 编译为可选路径前缀：**/*.md 同时命中根目录 a.md 与子目录 sub/b.md
  const re = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\0')
    .replace(/\*\*/g, '[\\s\\S]*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/\0/g, '(?:.*/)?') + '$';
  return new RegExp(re).test(relPath);
}

// 递归收集文件（忽略清单：体积大且与任务无关的目录）
const IGNORE = new Set(['node_modules', '.git', '.archives', 'uploads']);
function walkFiles(dir, base, out, depth) {
  if (depth > 8) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    const rel = path.relative(base, fp);
    if (e.isDirectory()) walkFiles(fp, base, out, depth + 1);
    else if (e.isFile() && /\.(txt|md|json|csv|html|js|css|xml|log|yaml|yml|py|ts)$/i.test(e.name)) out.push({ fp, rel });
  }
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径；含 * 或 ** 时按 glob 模式统计所有匹配文件（如 "**/*.md"）' },
      top: { type: 'number', description: 'glob 模式下最多列出的文件数（默认 20，汇总始终包含全部匹配）' }
    },
    required: ['path']
  },
  run: async (args, ctx) => {
    let userPath = String(args.path || '');
    // 路径标准化（v0.9.23）：去除工作区前缀，防双重拼接
    if (ctx.cwd && userPath.startsWith(ctx.cwd)) {
      userPath = userPath.slice(ctx.cwd.length);
      if (userPath.startsWith('/') || userPath.startsWith('\\')) userPath = userPath.slice(1);
    }
    const hasGlob = /[*?]/.test(userPath);

    if (!hasGlob) {
      const fp = path.resolve(ctx.cwd, userPath);
      if (!fp.startsWith(ctx.cwd)) throw new Error(`路径越界：${userPath}`);
      if (!fs.existsSync(fp)) throw new Error(`文件不存在：${userPath}`);
      if (fs.statSync(fp).isDirectory()) throw new Error(`${userPath} 是目录；目录统计请用 glob 模式（如 "${userPath === '' ? '' : userPath.replace(/\/+$/, '') + '/'}**/*.md"）`);
      if (fs.statSync(fp).size > 2 * 1024 * 1024) throw new Error(`文件过大（${(fs.statSync(fp).size / 1024 / 1024).toFixed(1)}MB），仅支持 2MB 以内文本文件`);
      const s = statFile(fp);
      return [
        `文件统计：${userPath}`,
        `字符数（含空白）：${s.chars}`,
        `CJK 字数（中日韩字数口径）：${s.cjk}`,
        `行数：${s.lines}`,
        `词数（空白分隔）：${s.words}`,
        `字节：${s.bytes}`,
        `修改时间：${s.mtime}`
      ].join('\n');
    }

    // glob 模式：递归收集 + 匹配 + 分组统计
    const files = [];
    walkFiles(ctx.cwd, ctx.cwd, files, 0);
    const matched = files.filter(f => globMatch(f.rel, userPath));
    if (!matched.length) throw new Error(`无匹配文件：${userPath}（可先 tree 查看目录结构）`);
    const top = Math.max(1, Math.min(Math.floor(Number(args.top) || 20), 100));
    const rows = matched.map(f => {
      const s = statFile(f.fp);
      return { path: f.rel, ...s };
    });
    const sum = rows.reduce((a, r) => ({
      chars: a.chars + r.chars, cjk: a.cjk + r.cjk, lines: a.lines + r.lines, words: a.words + r.words, bytes: a.bytes + r.bytes
    }), { chars: 0, cjk: 0, lines: 0, words: 0, bytes: 0 });
    const lines = [
      `匹配 ${rows.length} 个文件（模式：${userPath}）汇总：`,
      `字符数 ${sum.chars} / CJK 字数 ${sum.cjk} / 行数 ${sum.lines} / 词数 ${sum.words} / 字节 ${sum.bytes}`,
      ''
    ];
    // 按 CJK 字数降序，长文交付核验时主要文件一眼可见
    rows.sort((a, b) => b.cjk - a.cjk || b.chars - a.chars);
    for (const r of rows.slice(0, top)) {
      lines.push(`- ${r.path}：CJK ${r.cjk} / 字符 ${r.chars} / ${r.lines} 行（修改 ${r.mtime}）`);
    }
    if (rows.length > top) lines.push(`…另有 ${rows.length - top} 个文件未列出（汇总已包含）`);
    return lines.join('\n');
  }
};
