// @name diff
// @desc 文本/文件差异对比（零 token）：行级 diff 输出统一格式 + 变化行数摘要。返修后用它验证"是否真的改了"，零变化 = 返修失败
// @essential false
const fs = require('fs');
const path = require('path');

// 行级 LCS diff（O(n*m) DP，文件行数上限保护 5000 行——超出降级为行数/首尾对比）
function lcsDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  // DP 表（滚动数组压内存：只需上一行）
  let prev = new Array(m + 1).fill(0);
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = aLines[i - 1] === bLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
    dp[i] = cur;
  }
  // 回溯生成操作序列
  const ops = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) { ops.unshift({ t: '=', l: aLines[i - 1] }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { ops.unshift({ t: '-', l: aLines[i - 1] }); i--; }
    else { ops.unshift({ t: '+', l: bLines[j - 1] }); j--; }
  }
  while (i > 0) { ops.unshift({ t: '-', l: aLines[i - 1] }); i--; }
  while (j > 0) { ops.unshift({ t: '+', l: bLines[j - 1] }); j--; }
  return ops;
}

// 操作序列 → 带 hunk 上下文的统一 diff
function toUnified(ops, context) {
  const hunks = [];
  let idx = 0;
  const aCount = {}; // 追踪行号
  let aLine = 0, bLine = 0;
  const tagged = ops.map(op => {
    const item = { ...op, aLine: 0, bLine: 0 };
    if (op.t === '=') { item.aLine = ++aLine; item.bLine = ++bLine; }
    else if (op.t === '-') { item.aLine = ++aLine; }
    else { item.bLine = ++bLine; }
    return item;
  });
  while (idx < tagged.length) {
    if (tagged[idx].t === '=') { idx++; continue; }
    // 找到变更块起点，回溯 context 行
    let start = Math.max(0, idx - context);
    // 向后扫描到变更结束后 context 行
    let end = idx;
    let lastChange = idx;
    while (end < tagged.length && (end - lastChange <= context || tagged[end].t !== '=')) {
      if (tagged[end].t !== '=') lastChange = end;
      if (end - lastChange > context) break;
      end++;
    }
    const hunk = tagged.slice(start, Math.min(tagged.length, lastChange + context + 1));
    const aStart = hunk.find(h => h.aLine) || { aLine: 1 };
    const bStart = hunk.find(h => h.bLine) || { bLine: 1 };
    const aLen = hunk.filter(h => h.t !== '+').length;
    const bLen = hunk.filter(h => h.t !== '-').length;
    hunks.push({
      header: `@@ -${aStart.aLine},${aLen} +${bStart.bLine},${bLen} @@`,
      lines: hunk.map(h => (h.t === '=' ? ' ' : h.t) + h.l)
    });
    idx = lastChange + context + 1;
  }
  return hunks;
}

function resolveArg(argVal, ctx, label) {
  const s = String(argVal || '');
  if (!s.trim()) throw new Error(`${label} 为空`);
  const isFile = !/\n/.test(s) && s.length < 500 && /^[^:*?"<>|]+\.[a-z0-9]{1,6}$/i.test(s.trim()) && fs.existsSync(path.resolve(ctx.cwd, s.trim()));
  if (isFile) {
    let p = s.trim();
    if (ctx.cwd && p.startsWith(ctx.cwd)) {
      p = p.slice(ctx.cwd.length).replace(/^[/\\]/, '');
    }
    const fp = path.resolve(ctx.cwd, p);
    if (!fp.startsWith(ctx.cwd)) throw new Error(`路径越界：${s}`);
    return { lines: fs.readFileSync(fp, 'utf8').split('\n'), src: `文件 ${p}` };
  }
  return { lines: s.split('\n'), src: '内联文本' };
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      left: { type: 'string', description: '对比左侧：文件路径或多行文本' },
      right: { type: 'string', description: '对比右侧：文件路径或多行文本' },
      context: { type: 'number', description: '变更块的上下文行数（默认 3）' },
      maxLines: { type: 'number', description: '参与 diff 的最大行数（默认 5000，超出截断提示）' }
    },
    required: ['left', 'right']
  },
  run: async (args, ctx) => {
    const A = resolveArg(args.left, ctx, 'left');
    const B = resolveArg(args.right, ctx, 'right');
    const context = Math.max(0, Math.min(Math.floor(Number(args.context) || 3), 10));
    const maxLines = Math.max(100, Math.min(Math.floor(Number(args.maxLines) || 5000), 20000));
    let aLines = A.lines, bLines = B.lines;
    let truncated = false;
    if (aLines.length > maxLines || bLines.length > maxLines) {
      truncated = true;
      aLines = aLines.slice(0, maxLines);
      bLines = bLines.slice(0, maxLines);
    }
    const ops = lcsDiff(aLines, bLines);
    const added = ops.filter(o => o.t === '+').length;
    const removed = ops.filter(o => o.t === '-').length;
    const head = [
      `差异对比：${A.src} → ${B.src}`,
      `结果：${added + removed === 0 ? '完全相同（零差异）' : `+${added} 行新增 / -${removed} 行删除`}${truncated ? `（超出 ${maxLines} 行已截断）` : ''}`
    ].join('\n');
    if (added + removed === 0) return head + '\n\n（两份内容完全一致——若这是返修后的验证，说明本轮返修没有产生任何实际修改）';
    const hunks = toUnified(ops, context);
    const body = hunks.slice(0, 30).map(h => [h.header, ...h.lines].join('\n')).join('\n');
    const tail = hunks.length > 30 ? `\n…另有 ${hunks.length - 30} 个变更块未展示` : '';
    return head + '\n\n' + body + tail;
  }
};
