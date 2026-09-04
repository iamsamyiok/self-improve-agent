// @name write
// @desc 写入文本文件（自动建父目录；覆盖走原子写；append 追加带重试幂等保护；智能区分「续写误用覆盖」与「整体重构」）
// @essential true
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 粗相似度：词集重叠率（0~1）。用于区分「重构」（内容截然不同）与「续写误用覆盖」（高度重叠）
function similarity(a, b) {
  const tok = s => new Set(String(s).toLowerCase().split(/[\s,;:!?，。；：！？"'`()\[\]{}<>]+/).filter(w => w.length > 1));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

// 原子覆盖：先写同目录临时文件再 rename，写一半崩溃/断电不会损坏原文件
function atomicWrite(fp, body) {
  const tmp = path.join(path.dirname(fp), `.${path.basename(fp)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, fp);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      content: { type: 'string', description: '要写入的内容（append 模式下为要追加的片段）' },
      append: { type: 'boolean', description: 'true 时追加到文件末尾（文件不存在则创建），长文分段写入必须用此模式' },
      confirm: { type: 'boolean', description: '强警告覆盖的二次确认，true 才允许整体覆盖（完全重构成不同内容时会被自动放行，无需 confirm）' }
    },
    required: ['path', 'content']
  },
  run: async (args, ctx) => {
    // 工作区路径沙箱：模型常把进程根（/workspace）当工作区根，产出写到工程目录外。
    // 统一收敛：工作区内放行；进程根/工程根下的路径剥前缀重定向回工作区；外部路径拒绝。
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
    // P0 修复：路径标准化——如果输入路径已包含工作区前缀，自动去除避免双重嵌套
    let userPath = String(args.path || '');
    if (ctx.cwd && userPath.startsWith(ctx.cwd)) {
      // 绝对路径但包含 cwd，去掉前缀
      userPath = userPath.slice(ctx.cwd.length);
      if (userPath.startsWith('/') || userPath.startsWith('\\')) {
        userPath = userPath.slice(1);
      }
    }
    const fp = __safeResolve(ctx.cwd, userPath);
    // 软失败一律 throw：框架据此标记失败并计入评审统计
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) {
      throw new Error(`${fp} 是目录，请提供完整文件路径（需包含文件名，如 game.html）`);
    }
    const body = String(args.content ?? '');
    fs.mkdirSync(path.dirname(fp), { recursive: true });

    if (args.append === true) {
      // ---- 追加模式：带重试幂等保护 ----
      // 场景：参数传输失败后模型重试，但上一段其实已写入成功 → 原样再发同一段。
      // 无保护会静默重复，文件出现两份相同段落。检测：内容已完整存在于文件尾部 → 跳过。
      if (fs.existsSync(fp)) {
        const old = fs.readFileSync(fp, 'utf8');
        if (body.length >= 40 && old.length >= body.length) {
          const tailWin = old.slice(-body.length * 3); // 尾部窗口足够覆盖一次重复
          if (tailWin.includes(body)) {
            const tail = body.length > 120 ? '…' + body.slice(-120) : body;
            return `幂等保护：此段已存在于 ${fp} 末尾（上次调用实际已成功，属重试重复），本次未重复追加。文件现共 ${Buffer.byteLength(old, 'utf8')} 字节。该段末尾：${JSON.stringify(tail)}`;
          }
        }
      }
      const existed = fs.existsSync(fp);
      fs.appendFileSync(fp, body, 'utf8');
      const total = fs.statSync(fp).size;
      // 带回末尾摘要：模型无需再 read 就能衔接下一段
      const tail = body.length > 120 ? '…' + body.slice(-120) : body;
      return `已追加 ${body.length} 字符到 ${fp}${existed ? '' : '（新建）'}，文件现共 ${total} 字节。本次追加末尾：${JSON.stringify(tail)}`;
    }

    // ---- 覆盖模式：智能区分「续写误用」与「整体重构」 ----
    if (fs.existsSync(fp)) {
      const old = fs.readFileSync(fp, 'utf8');
      if (old.length >= 200 && old !== body) {
        const sim = similarity(old, body);
        if (sim >= 0.3) {
          // 高度重叠却要整体覆盖 = 典型的「忘记 append 语义」，前文会被静默清掉 → 强拦
          if (!args.confirm) {
            throw new Error(`拒绝覆盖：${fp} 已有 ${old.length} 字符，与本次内容重叠度 ${(sim * 100).toFixed(0)}%（判定为续写场景）。` +
              `续写请用 append=true 重发本次内容（content 无需改动，加上 append:true 即可）；` +
              `确实要整体替换文件才加 confirm=true。`);
          }
          atomicWrite(fp, body);
          return `已覆盖 ${fp}（原 ${old.length} 字符 → 新 ${body.length} 字符，confirm=true 已确认，原子写入）`;
        }
        // 重叠度低 = 模型有意重构成不同内容 → 自动放行，不卡流程
        atomicWrite(fp, body);
        return `已重写 ${fp}（原 ${old.length} 字符 → 新 ${body.length} 字符，重叠度 ${(sim * 100).toFixed(0)}% 判定为整体重构，自动放行，原子写入）`;
      }
    }
    atomicWrite(fp, body);
    return `已写入 ${fp}（${body.length} 字符）`;
  }
};
