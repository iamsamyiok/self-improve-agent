// @name doc
// @desc 本地文档处理：list 列出 / read 读内容（纯文本直读，PDF/DOCX/XLSX 纯 JS 提取）/ search 全文检索（存工作区 uploads/）
// @essential false
//
// 借鉴 mistralai search-starter-app（Search Toolkit：摄入管道 + 混合检索）的轻量版——
// 本地文档量级小（个人工作区），无需 Vespa 向量库：关键词检索 + 相关度评分足够，
// 且保持项目零依赖铁律（提取器全部手写，仅用 Node 内置 zlib）。
// 提取器定位"尽力而为"：PDF 依赖文本操作符可解析（扫描件/无 ToUnicode 的 CID 字体会丢字），
// 失败时明确报错并给出可操作建议（转存 txt/md）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function uploadsDir(ctx) { return path.join(ctx.cwd, 'uploads'); }

// ---------- PDF 文本提取（纯 JS，尽力而为） ----------
// 思路：逐个解出 stream...endstream 块，FlateDecode 的用 zlib 解压；在内容流里
// 扫描 BT..ET 文本块中的 (..) Tj / [(..)..] TJ / <..> Tj 操作符拼接文本。
// 限制：图片型扫描件、无 ToUnicode 映射的 CID 字体无法提取（返回可操作错误）
function pdfDecodePdfString(s) {
  // 字面量字符串：处理 \n \r \t \b \f \( \) \\ \ddd 八进制
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += n; // \( \) \\ 及其余
  }
  return out;
}
function pdfExtractTextOps(content) {
  // 仅处理文本区 BT..ET；识别 (...)Tj、[... ]TJ、<...>Tj 与换行指令
  let text = '';
  const btBlocks = [];
  let inText = false, segStart = 0;
  const push = (a, b) => btBlocks.push(content.slice(a, b));
  for (let i = 0; i < content.length - 1; i++) {
    if (!inText && content[i] === 'B' && content[i + 1] === 'T') { inText = true; segStart = i + 2; }
    else if (inText && content[i] === 'E' && content[i + 1] === 'T') { inText = false; push(segStart, i); }
  }
  if (inText) push(segStart, content.length);
  for (const block of btBlocks) {
    let i = 0;
    const len = block.length;
    while (i < len) {
      const c = block[i];
      if (c === '(') {
        // 找配对右括号（考虑转义与嵌套）
        let depth = 1, j = i + 1;
        while (j < len && depth > 0) {
          if (block[j] === '\\') { j += 2; continue; }
          if (block[j] === '(') depth++;
          else if (block[j] === ')') depth--;
          j++;
        }
        text += pdfDecodePdfString(block.slice(i + 1, j - 1));
        i = j;
      } else if (c === '[') {
        const close = block.indexOf(']', i);
        if (close < 0) break;
        // TJ 数组：提取所有 (..) 片段
        const arr = block.slice(i + 1, close);
        for (let k = 0; k < arr.length; k++) {
          if (arr[k] === '(') {
            let depth = 1, j = k + 1;
            while (j < arr.length && depth > 0) {
              if (arr[j] === '\\') { j += 2; continue; }
              if (arr[j] === '(') depth++;
              else if (arr[j] === ')') depth--;
              j++;
            }
            text += pdfDecodePdfString(arr.slice(k + 1, j - 1));
            k = j;
          }
        }
        i = close + 1;
      } else if (c === '<' && block[i + 1] !== '<') {
        const close = block.indexOf('>', i);
        if (close < 0) break;
        const hex = block.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '');
        for (let k = 0; k + 1 < hex.length; k += 2) text += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
        i = close + 1;
      } else if (c === 'T' || c === 't' || c === '\'' || c === '"') {
        // T* / TD / Td / ' / " 等——近似换行
        if (block[i] === '\'' || block[i] === '"' || /T[dD*]/.test(block.substr(i, 2))) {
          if (!text.endsWith('\n')) text += '\n';
        }
        i++;
      } else i++;
    }
    if (text && !text.endsWith('\n')) text += '\n';
  }
  return text;
}
function pdfTextExtract(buf) {
  const raw = buf.toString('latin1');
  if (!raw.includes('PDF-')) throw new Error('PDF 结构异常（缺文件头）');
  let collected = '';
  let idx = 0;
  while (true) {
    const s = raw.indexOf('stream', idx);
    if (s < 0) break;
    let dataStart = s + 6;
    if (raw[dataStart] === '\r') dataStart++;
    if (raw[dataStart] === '\n') dataStart++;
    const e = raw.indexOf('endstream', dataStart);
    if (e < 0) break;
    const chunk = Buffer.from(raw.slice(dataStart, e), 'latin1');
    let content = null;
    try { content = zlib.inflateSync(chunk).toString('latin1'); } catch { content = chunk.toString('latin1'); }
    // 只解析含文本操作符的流
    if (/(Tj|TJ)\s/.test(content) || /(Tj|TJ)$/.test(content.trim())) collected += pdfExtractTextOps(content);
    idx = e + 9;
  }
  const clean = collected.replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) {
    throw new Error('未能从 PDF 提取到文本（常见原因：扫描件图片型 PDF、或字体无 ToUnicode 映射）。建议：转存为 txt/md 后上传，或复制正文粘贴到对话');
  }
  return clean;
}

// ---------- 最小 zip 读取器（stored + deflate） ----------
// DOCX/XLSX 是 zip 容器：EOCD 定位 central directory → 条目名/偏移 → local header 读数据
function zipReadEntries(buf) {
  const sig = (off) => buf.readUInt32LE(off);
  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构异常（缺 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (sig(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, csize, lho });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const ent = entries.get(name);
    if (!ent) return null;
    const lhNameLen = buf.readUInt16LE(ent.lho + 26);
    const lhExtraLen = buf.readUInt16LE(ent.lho + 28);
    const dataStart = ent.lho + 30 + lhNameLen + lhExtraLen;
    const data = buf.subarray(dataStart, dataStart + ent.csize);
    if (ent.method === 0) return Buffer.from(data);
    if (ent.method === 8) return zlib.inflateSync(data);
    throw new Error(`不支持的压缩方式 ${ent.method}（${name}）`);
  };
  return { names: [...entries.keys()], read };
}

// ---------- DOCX 文本提取 ----------
function xmlDecodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');
}
function docxTextExtract(buf) {
  const zip = zipReadEntries(buf);
  const doc = zip.read('word/document.xml');
  if (!doc) throw new Error('DOCX 结构异常（缺 word/document.xml）');
  const xml = doc.toString('utf8');
  let out = '';
  // 段落 </w:p> 换行；<w:t> 内容拼接；<w:tab/> 制表
  const paras = xml.split(/<\/w:p>/);
  for (const p of paras) {
    let line = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>/g;
    let m;
    while ((m = re.exec(p))) line += m[1] === undefined ? '\t' : xmlDecodeEntities(m[1]);
    if (line.trim()) out += line + '\n';
  }
  const clean = out.trim();
  if (!clean) throw new Error('DOCX 未提取到文本（可能为空文档或纯图片）');
  return clean;
}

// ---------- XLSX 文本提取（sharedStrings + 各 sheet） ----------
function xlsxTextExtract(buf) {
  const zip = zipReadEntries(buf);
  let shared = [];
  const ss = zip.read('xl/sharedStrings.xml');
  if (ss) {
    const xml = ss.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) {
      let t = '';
      const tr = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let mm;
      while ((mm = tr.exec(m[1]))) t += xmlDecodeEntities(mm[1]);
      shared.push(t);
    }
  }
  const sheets = zip.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (!sheets.length) throw new Error('XLSX 结构异常（无 worksheet）');
  let out = '';
  for (const sn of sheets) {
    const xml = zip.read(sn).toString('utf8');
    out += `【${sn.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '')}】\n`;
    for (const rowXml of xml.split(/<\/row>/)) {
      let line = [];
      const cr = /<c(\s[^>]*)?>([\s\S]*?)<\/c>|<c(\s[^>]*)?\/>/g;
      let m;
      while ((m = cr.exec(rowXml))) {
        const attrs = m[1] || m[3] || '';
        const body = m[2] || '';
        const isShared = /t="s"/.test(attrs);
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        const tm = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body);
        let cell = '';
        if (isShared && vm) cell = shared[Number(vm[1])] ?? '';
        else if (vm) cell = xmlDecodeEntities(vm[1]);
        else if (tm) cell = xmlDecodeEntities(tm[1]);
        line.push(cell);
      }
      if (line.some(x => x !== '')) out += line.join('\t') + '\n';
    }
    out += '\n';
  }
  const clean = out.trim();
  if (!clean) throw new Error('XLSX 未提取到单元格内容');
  return clean;
}

// ---------- 统一文档读取 ----------
const TEXT_EXTS = new Set(['.txt', '.md', '.json', '.csv', '.log', '.js', '.ts', '.py', '.sh', '.html', '.htm', '.xml', '.yml', '.yaml', '.ini', '.conf', '.sql', '.css', '.java', '.go', '.c', '.h', '.cpp', '.rs']);
function docReadText(fp, ext) {
  const buf = fs.readFileSync(fp);
  if (ext === '.pdf') return pdfTextExtract(buf);
  if (ext === '.docx') return docxTextExtract(buf);
  if (ext === '.xlsx') return xlsxTextExtract(buf);
  if (TEXT_EXTS.has(ext)) return buf.toString('utf8');
  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') {
    throw new Error(`旧版二进制格式 ${ext} 暂不支持——请另存为 ${ext === '.doc' ? 'docx' : 'xlsx'} 或 txt 后上传`);
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
    throw new Error('图片无法提取文本（当前模型为纯文本）——图片已存储，可通过 /files/ 链接查看；如需识别图中文字请转文字后上传');
  }
  throw new Error(`不支持的文档类型 ${ext}（支持：${[...TEXT_EXTS].slice(0, 8).join(' ')} pdf docx xlsx）`);
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'search'], description: '操作：list 列出已上传文档 / read 读取文档内容 / search 全文检索' },
      path: { type: 'string', description: 'read 时必填：文件名或 uploads/ 相对路径' },
      query: { type: 'string', description: 'search 时必填：关键词（空格分隔多词）' },
      tail: { type: 'number', description: 'read 可选：只读末尾 N 行（长文档先看尾部结论）' }
    },
    required: ['action']
  },
  run: async (args, ctx) => {
    const dir = uploadsDir(ctx);
    if (args.action === 'list') {
      if (!fs.existsSync(dir)) return 'uploads/ 目录尚未创建（还没有上传过文档——聊天框左侧附件按钮上传）';
      const files = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile())
        .map(f => {
          const st = fs.statSync(path.join(dir, f));
          return `${f}（${(st.size / 1024).toFixed(1)}KB，${new Date(st.mtimeMs).toLocaleString()}）`;
        });
      if (!files.length) return 'uploads/ 目录为空（还没有上传过文档）';
      return `已上传 ${files.length} 个文档：\n` + files.map(f => '- uploads/' + f).join('\n');
    }
    if (args.action === 'read') {
      const rel = String(args.path || '').replace(/^\/+/, '').replace(/^uploads\//, '');
      const fp = path.resolve(dir, rel);
      if (!fp.startsWith(dir)) throw new Error('路径越界（只允许读 uploads/ 内文档）');
      if (!fs.existsSync(fp)) {
        const has = fs.existsSync(dir) ? fs.readdirSync(dir).join('、') : '';
        throw new Error(`文档不存在：uploads/${rel}${has ? `（现有：${has}）` : '（uploads 为空，可先 doc.list 查看）'}`);
      }
      const ext = path.extname(fp).toLowerCase();
      let text = docReadText(fp, ext);
      if (args.tail) {
        const lines = text.split('\n');
        text = `（全文 ${lines.length} 行，显示末尾 ${Math.min(Number(args.tail), lines.length)} 行）\n` + lines.slice(-Number(args.tail)).join('\n');
      } else if (text.length > 30000) {
        text = text.slice(0, 30000) + `\n…（文档过长已截断，共 ${text.length} 字符；可用 tail 参数分段读取）`;
      }
      return `【uploads/${rel}】\n${text}`;
    }
    if (args.action === 'search') {
      const q = String(args.query || '').trim();
      if (!q) throw new Error('query 为空（检索关键词）');
      if (!fs.existsSync(dir)) return 'uploads/ 目录尚未创建（还没有上传过文档）';
      const terms = q.split(/\s+/);
      const hits = [];
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (!fs.statSync(fp).isFile()) continue;
        let text;
        try { text = docReadText(fp, path.extname(f).toLowerCase()); } catch { continue; } // 无法提取的跳过
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const lower = lines[i].toLowerCase();
          const score = terms.reduce((n, t) => n + (lower.includes(t.toLowerCase()) ? 1 : 0), 0);
          if (score > 0) hits.push({ f, i, score, line: lines[i].trim().slice(0, 200) });
        }
      }
      if (!hits.length) return `全部文档中未命中关键词：${q}`;
      hits.sort((a, b) => b.score - a.score);
      const byDoc = new Map();
      for (const h of hits.slice(0, 20)) {
        if (!byDoc.has(h.f)) byDoc.set(h.f, []);
        byDoc.get(h.f).push(`  L${h.i + 1}: ${h.line}`);
      }
      return `命中 ${hits.length} 行（关键词：${q}），Top20：\n` + [...byDoc.entries()].map(([f, ls]) => `【uploads/${f}】\n` + ls.join('\n')).join('\n');
    }
    throw new Error(`未知操作：${args.action}（支持 list/read/search）`);
  }
};
