// @name archive
// @desc 检查点归档：save 全量快照 / list 列出 / restore 恢复 / diff 与指定快照对比。长任务分段写入前的检查点，返修失败可回滚到上个稳定状态
// @essential false
const fs = require('fs');
const path = require('path');

const IGNORE = new Set(['node_modules', '.git', '.archives', '.intent.json', '.todo.json', '.memory-short.json', '.memory-long.json', 'inner-usage.json', 'inner-messages.json', 'process.md', 'uploads']);
const MAX_FILES = 500;
const MAX_SIZE = 20 * 1024 * 1024;

function archiveRoot(ctx) { return path.join(ctx.cwd, '.archives'); }

function collectFiles(dir, base, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(fp, base, out);
    else if (e.isFile()) {
      try {
        const st = fs.statSync(fp);
        if (st.size <= 2 * 1024 * 1024) out.push({ fp, rel: path.relative(base, fp), size: st.size });
      } catch { /* ignore */ }
    }
  }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of collect2(src)) {
    const target = path.join(dest, f.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.fp, target);
  }
}
function collect2(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile()) out.push({ fp, rel: path.relative(root, fp) });
    }
  };
  walk(root);
  return out;
}

function tagDir(ctx, tag) {
  if (!/^[a-z0-9-]{1,40}$/i.test(tag)) throw new Error(`归档名不合法（限字母数字连字符）：${tag}`);
  return path.join(archiveRoot(ctx), tag);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'list', 'restore', 'diff', 'clean'], description: 'save=创建快照 / list=列出快照 / restore=恢复到快照 / diff=当前与快照对比文件清单 / clean=删除快照' },
      tag: { type: 'string', description: '快照名（save 默认 auto-<时间戳>；restore/diff/clean 必填）' }
    },
    required: ['action']
  },
  run: async (args, ctx) => {
    const action = String(args.action || '');

    if (action === 'save') {
      const tag = String(args.tag || `auto-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`).toLowerCase();
      const dest = tagDir(ctx, tag);
      if (fs.existsSync(dest)) throw new Error(`快照已存在：${tag}（换名或先 clean）`);
      const files = [];
      collectFiles(ctx.cwd, ctx.cwd, files);
      if (!files.length) throw new Error('工作区无文本文件可归档（忽略清单外为空）');
      if (files.length > MAX_FILES) throw new Error(`文件过多（${files.length} > ${MAX_FILES}）：归档范围过大，请整理工作区`);
      const total = files.reduce((a, f) => a + f.size, 0);
      if (total > MAX_SIZE) throw new Error(`归档总量 ${(total / 1024 / 1024).toFixed(1)}MB 超上限 20MB`);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of files) {
        const target = path.join(dest, f.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(f.fp, target);
      }
      const manifest = { tag, ts: new Date().toISOString(), files: files.map(f => ({ path: f.rel, size: f.size })) };
      fs.writeFileSync(path.join(dest, '.manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
      return `快照已创建：${tag}（${files.length} 个文件，${(total / 1024).toFixed(1)}KB，时间 ${manifest.ts.slice(0, 19).replace('T', ' ')}）`;
    }

    if (action === 'list') {
      const root = archiveRoot(ctx);
      let dirs = [];
      try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { /* 无归档 */ }
      if (!dirs.length) return '当前工作区无快照（长任务分段写入前建议 archive.save 打检查点）';
      const rows = dirs.map(d => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(root, d.name, '.manifest.json'), 'utf8'));
          return `- ${d.name}：${m.files.length} 个文件（${new Date(m.ts).toLocaleTimeString()} 创建）`;
        } catch {
          return `- ${d.name}：（清单缺失）`;
        }
      });
      return `快照列表（${rows.length} 个，恢复用 restore）：\n${rows.join('\n')}`;
    }

    if (action === 'restore') {
      const tag = String(args.tag || '');
      if (!tag) throw new Error('restore 需要 tag 参数（先 list 查看）');
      const src = tagDir(ctx, tag);
      if (!fs.existsSync(src)) throw new Error(`快照不存在：${tag}（先 list 查看）`);
      // 恢复 = 快照内容覆盖回工作区（快照里没有的文件不动——只回滚快照覆盖的文件）
      const files = collect2(src).filter(f => f.rel !== '.manifest.json');
      let restored = 0, missing = 0;
      for (const f of files) {
        const target = path.join(ctx.cwd, f.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(f.fp, target);
        restored++;
      }
      // 快照里有但工作区后来删了的文件：提示（不自动删工作区新文件，防误伤）
      const manifest = (() => { try { return JSON.parse(fs.readFileSync(path.join(src, '.manifest.json'), 'utf8')); } catch { return null; } })();
      if (manifest) {
        for (const f of manifest.files) {
          if (!fs.existsSync(path.join(ctx.cwd, f.path))) missing++;
        }
      }
      return `已恢复快照 ${tag}：${restored} 个文件写回工作区${missing ? `；${missing} 个快照内文件当前不存在（工作区后来删除，未自动重建）` : ''}`;
    }

    if (action === 'diff') {
      const tag = String(args.tag || '');
      if (!tag) throw new Error('diff 需要 tag 参数');
      const src = tagDir(ctx, tag);
      if (!fs.existsSync(src)) throw new Error(`快照不存在：${tag}`);
      const snapFiles = new Map(collect2(src).filter(f => f.rel !== '.manifest.json').map(f => [f.rel, fs.readFileSync(f.fp, 'utf8')]));
      const curFiles = [];
      collectFiles(ctx.cwd, ctx.cwd, curFiles);
      const curMap = new Map(curFiles.map(f => [f.rel, fs.readFileSync(f.fp, 'utf8')]));
      const changed = [], added = [], removedSnap = [];
      for (const [rel, content] of curMap) {
        if (!snapFiles.has(rel)) added.push(rel);
        else if (snapFiles.get(rel) !== content) changed.push(rel);
      }
      for (const rel of snapFiles.keys()) if (!curMap.has(rel)) removedSnap.push(rel);
      const total = changed.length + added.length + removedSnap.length;
      if (!total) return `与快照 ${tag} 完全一致（零变化）`;
      const lines = [`与快照 ${tag} 对比：${changed.length} 个修改 / ${added.length} 个新增 / ${removedSnap.length} 个已删`];
      changed.slice(0, 20).forEach(r => lines.push(`~ ${r}`));
      added.slice(0, 20).forEach(r => lines.push(`+ ${r}`));
      removedSnap.slice(0, 20).forEach(r => lines.push(`- ${r}`));
      if (changed.length + added.length + removedSnap.length > 60) lines.push('…超过 60 项未全部展示');
      return lines.join('\n');
    }

    if (action === 'clean') {
      const tag = String(args.tag || '');
      if (!tag) throw new Error('clean 需要 tag 参数');
      const dir = tagDir(ctx, tag);
      if (!fs.existsSync(dir)) throw new Error(`快照不存在：${tag}`);
      fs.rmSync(dir, { recursive: true, force: true });
      return `快照 ${tag} 已删除`;
    }

    throw new Error(`未知操作：${action}（可用：save / list / restore / diff / clean）`);
  }
};
