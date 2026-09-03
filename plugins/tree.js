// @name tree
// @desc 目录结构浏览：树形列出文件（带类型/大小标记，深度可控）。比 bash ls 更安全（无命令注入面）且输出带层级结构
// @essential false
const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules', '.git', '.archives']);
const MAX_ENTRIES = 400; // 输出条目上限（防巨型目录刷屏）

module.exports = {
  params: {
    type: 'object',
    properties: {
      dir: { type: 'string', description: '起始目录（默认工作区根；相对路径）' },
      depth: { type: 'number', description: '最大深度（默认 3，上限 6）' },
      files: { type: 'boolean', description: 'true 只列文件（默认目录和文件都列）' }
    }
  },
  run: async (args, ctx) => {
    let userDir = String(args.dir || '');
    if (ctx.cwd && userDir.startsWith(ctx.cwd)) {
      userDir = userDir.slice(ctx.cwd.length).replace(/^[/\\]/, '');
    }
    const root = path.resolve(ctx.cwd, userDir);
    if (!root.startsWith(ctx.cwd)) throw new Error(`路径越界：${args.dir}`);
    if (!fs.existsSync(root)) throw new Error(`目录不存在：${args.dir || '.'}（可先 tree 不带参数看工作区根）`);
    if (!fs.statSync(root).isDirectory()) throw new Error(`${args.dir} 是文件（读内容用 read 插件）`);
    const depth = Math.max(1, Math.min(Math.floor(Number(args.depth) || 3), 6));
    const filesOnly = args.files === true;
    const out = [];
    let count = 0;
    let truncated = false;

    const fmtSize = n => n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;

    const walk = (dir, prefix, level) => {
      if (level > depth || truncated) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      // 目录优先 + 名称排序（稳定性）
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (let i = 0; i < entries.length; i++) {
        if (count >= MAX_ENTRIES) { truncated = true; return; }
        const e = entries[i];
        if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
        const isLast = i === entries.length - 1;
        const branch = isLast ? '└─ ' : '├─ ';
        let line;
        if (e.isDirectory()) {
          line = `${prefix}${branch}${e.name}/`;
          if (!filesOnly) { out.push(line); count++; }
          walk(path.join(dir, e.name), prefix + (isLast ? '   ' : '│  '), level + 1);
        } else if (e.isFile()) {
          let size = '';
          try { size = ` (${fmtSize(fs.statSync(path.join(dir, e.name)).size)})`; } catch { /* ignore */ }
          line = `${prefix}${branch}${e.name}${size}`;
          out.push(line);
          count++;
        }
      }
    };
    walk(root, '', 1);
    const header = `${userDir || '.'} 目录结构（深度 ${depth}${filesOnly ? '，仅文件' : ''}，${count} 项）：`;
    if (!out.length) return header + '\n\n（空目录）';
    return header + '\n\n' + out.join('\n') + (truncated ? `\n…已截断（超过 ${MAX_ENTRIES} 项；用 depth 参数收窄范围）` : '');
  }
};
