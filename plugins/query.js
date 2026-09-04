// @name query
// @desc 结构化数据提取（省 token）：JSON 点路径提取（$.data.items[*].name）/ CSV 条件筛选（select 列 where 条件），大文件只回填命中的字段
// @essential false
const fs = require('fs');
const path = require('path');

// 点路径求值（与 verify.json_path 同语义）：$.a.b / $.arr[0].name / $.arr[*].field
function getByPath(obj, expr) {
  let cur = obj;
  const segs = String(expr).replace(/^\$\.?/, '').split(/\.|(?=\[)/).filter(Boolean);
  for (const seg of segs) {
    if (cur === null || cur === undefined) return undefined;
    const arrAll = seg.match(/^\[\*\]$/);
    const arrIdx = seg.match(/^\[(\d+)\]$/);
    const key = seg.match(/^\[(".*"|'.*')\]$/);
    if (arrAll) {
      // [*] 展开：后续路径应用到每个元素，结果拍平
      if (!Array.isArray(cur)) return undefined;
      const restExpr = segs.slice(segs.indexOf(seg) + 1).join('');
      return cur.map(item => getByPath(item, restExpr)).filter(v => v !== undefined);
    }
    if (arrIdx) cur = cur[Number(arrIdx[1])];
    else if (key) cur = cur[key[1].slice(1, -1)];
    else cur = cur[seg];
  }
  return cur;
}

// CSV 条件筛选：select name,score where score>80（where 可省略；比较符 > >= < <= = != 和 contains）
function queryCsv(text, sqlLike) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV 至少需要表头 + 1 行数据');
  const header = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(l => {
    const cells = l.split(',').map(c => c.trim());
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] == null ? '' : cells[i]; });
    return row;
  });
  const m = String(sqlLike || '').trim().match(/^select\s+(.+?)(?:\s+where\s+(.+))?$/i);
  if (!m) throw new Error(`无法解析查询："${sqlLike}"。格式：select 列1,列2 where 列>值（where 可省略）`);
  const cols = m[1].split(',').map(c => c.trim()).filter(c => c !== '*');
  const wantAll = /\*/.test(m[1]);
  let out = rows;
  if (m[2]) {
    const wm = m[2].trim().match(/^(\S+?)\s*(>=|<=|!=|>|<|=|contains)\s*(.+)$/);
    if (!wm) throw new Error(`无法解析条件："${m[2]}"。支持：列>值 / 列=值 / 列!=值 / 列 contains 文本`);
    const [, col, op, rawVal] = wm;
    const val = rawVal.replace(/^["']|["']$/g, '');
    const num = Number(val);
    out = out.filter(row => {
      const cell = row[col];
      if (cell === undefined) throw new Error(`条件列 "${col}" 不在表头中（可用列：${header.join(', ')}）`);
      if (op === 'contains') return String(cell).includes(val);
      if ((op === '>' || op === '>=' || op === '<' || op === '<=') && !isNaN(num) && !isNaN(Number(cell))) {
        const c = Number(cell);
        return op === '>' ? c > num : op === '>=' ? c >= num : op === '<' ? c < num : c <= num;
      }
      if (op === '=') return String(cell) === val;
      if (op === '!=') return String(cell) !== val;
      return false;
    });
  }
  const result = out.map(row => wantAll ? row : Object.fromEntries(cols.map(c => {
    if (row[c] === undefined) throw new Error(`列 "${c}" 不在表头中（可用列：${header.join(', ')}）`);
    return [c, row[c]];
  })));
  return { header: wantAll ? header : cols, rows: result };
}

function fmtTable(header, rows, maxRows = 50) {
  const widths = header.map(h => Math.max(String(h).length, ...rows.slice(0, maxRows).map(r => String(r[h] == null ? '' : r[h]).length)));
  const line = (cells) => cells.map((c, i) => String(c == null ? '' : c).padEnd(widths[i])).join(' | ');
  const out = [line(header), widths.map(w => '-'.repeat(w)).join('-+-')];
  rows.slice(0, maxRows).forEach(r => out.push(line(header.map(h => r[h]))));
  if (rows.length > maxRows) out.push(`…另有 ${rows.length - maxRows} 行未展示`);
  return out.join('\n');
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'JSON/CSV 文件路径（相对工作目录）' },
      mode: { type: 'string', enum: ['json', 'csv'], description: '文件类型：json 用 expr 点路径提取；csv 用 expr 的 select...where... 筛选' },
      expr: { type: 'string', description: 'json：$.data.items[*].name 点路径（[*] 展开数组）；csv：select 列1,列2 where 列>值' }
    },
    required: ['path', 'mode', 'expr']
  },
  run: async (args, ctx) => {
    let userPath = String(args.path || '');
    if (ctx.cwd && userPath.startsWith(ctx.cwd)) {
      userPath = userPath.slice(ctx.cwd.length).replace(/^[/\\]/, '');
    }
    const fp = path.resolve(ctx.cwd, userPath);
    if (!fp.startsWith(ctx.cwd)) throw new Error(`路径越界：${args.path}`);
    if (!fs.existsSync(fp)) throw new Error(`文件不存在：${userPath}`);
    if (fs.statSync(fp).size > 5 * 1024 * 1024) throw new Error('文件过大（上限 5MB）');
    const text = fs.readFileSync(fp, 'utf8');
    const mode = String(args.mode || path.extname(fp).slice(1).toLowerCase());
    const expr = String(args.expr || '').trim();
    if (!expr) throw new Error('expr 不能为空');

    if (mode === 'json') {
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error(`JSON 解析失败：${e.message.slice(0, 120)}`); }
      const val = getByPath(data, expr);
      if (val === undefined) {
        // 给可操作提示：列出顶层键
        const topKeys = data && typeof data === 'object' ? Object.keys(data).slice(0, 15).join(', ') : typeof data;
        throw new Error(`路径未命中：${expr}。顶层可用字段：${topKeys}`);
      }
      const out = typeof val === 'string' ? val : JSON.stringify(val, null, 1);
      const head = `JSON 提取 ${userPath} ${expr}（${Array.isArray(val) ? `${val.length} 项` : typeof val}）：\n\n`;
      return head + (out.length > 4000 ? out.slice(0, 4000) + `\n…（结果过长已截断，共 ${out.length} 字符）` : out);
    }

    if (mode === 'csv') {
      const { header, rows } = queryCsv(text, expr);
      return `CSV 筛选 ${userPath}（${expr}，命中 ${rows.length} 行）：\n\n` + fmtTable(header, rows);
    }
    throw new Error(`不支持的 mode：${mode}（可用：json / csv）`);
  }
};
