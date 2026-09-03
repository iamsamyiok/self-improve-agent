// @name fetch
// @desc 抓取网页转纯文本（去导航/页脚/脚本噪音，正文优先；自动跟随重定向，15 秒超时；JSON 可结构化；length 可控制返回长度）
// @essential false
const UA = 'Mozilla/5.0 (compatible; dual-agent-inner/0.6; +https://github.com/iamsamyiok/dual-agent)';

// 行级噪音过滤：导航/城市列表/标签云特征行
//  - 「首页 | 预报 | 预警 | 雷达」竖线分隔 ≥4 段
//  - 连续 ≥12 个 1-4 字短词以空格相连（城市/栏目清单）
//  - 纯符号装饰行
function isNoiseLine(line) {
  const s = line.trim();
  if (!s) return true;
  if (/^[\s|·•—\-–_=*#.>]{4,}$/.test(s)) return true; // 纯分隔符/装饰
  const pipeParts = s.split(/[|｜]/).map(x => x.trim()).filter(Boolean);
  if (pipeParts.length >= 4 && pipeParts.every(x => x.length <= 12)) return true; // 竖线导航行
  const words = s.match(/[\u4e00-\u9fa5a-zA-Z0-9]{1,4}(\s+[\u4e00-\u9fa5a-zA-Z0-9]{1,4}){11,}/);
  if (words && s.length - words[0].length < 30) return true; // 短词清单行（其余裸内容极少才判噪音）
  return false;
}

// 块级噪音过滤：连续 ≥12 行、每行 ≤5 字、全无标点、且去重后仍有 ≥8 种不同行 = 单列菜单/城市清单
// （双条件防误杀：正常短行列表普遍行数少或重复度高，如天气词循环「雷阵雨×N」）
function dropMenuBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let buf = [];
  const flush = () => {
    if (buf.length >= 12 && new Set(buf.map(l => l.trim())).size >= 8) { buf = []; return; } // 菜单块丢弃；必须清空 buf，否则残留行会吞掉后续正常短行
    out.push(...buf);
    buf = [];
  };
  for (const l of lines) {
    const s = l.trim();
    if (s && s.length <= 5 && !/[，。！？；：、,.!?;:（）()【】\[\]{}"'/\\°%~%]/.test(s)) buf.push(l);
    else { flush(); out.push(l); }
  }
  flush();
  return out.join('\n');
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 http(s) 网址' },
      raw: { type: 'boolean', description: 'true = 保留原始 HTML（默认自动去噪提取正文文本）' },
      parseJson: { type: 'boolean', description: 'true = 尝试解析 JSON 并格式化输出（默认 false）' },
      length: { type: 'number', description: '返回正文字符数上限（默认 6000，最大 20000；翻页查看用 offset）' },
      offset: { type: 'number', description: '正文起始偏移字符数（默认 0；与 length 配合分段阅读长文）' }
    },
    required: ['url']
  },
  run: async (args) => {
    const raw = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) return 'URL 必须以 http:// 或 https:// 开头';
    const maxLen = Math.min(Math.max(Number(args.length) || 6000, 500), 20000);
    const offset = Math.max(Number(args.offset) || 0, 0);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const resp = await fetch(raw, {
        signal: ac.signal, redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: 'text/html,application/json;text/plain,*/*' }
      });
      const ct = resp.headers.get('content-type') || '';
      let body = await resp.text();
      // HTML 阶段截断放宽到 256KB：正文数据常在 DOM 后段（导航/script 在前段），64KB 会砍掉数据区
      if (body.length > 256 * 1024) body = body.slice(0, 256 * 1024) + '\n…（内容超 256KB 已截断）';

      // JSON 自动解析
      if (args.parseJson && /json/i.test(ct)) {
        try {
          const parsed = JSON.parse(body);
          body = JSON.stringify(parsed, null, 2);
          if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024) + '\n…（JSON 超长已截断）';
        } catch { /* 不是合法 JSON，继续用原文 */ }
      }

      if (!args.raw && /html/i.test(ct)) {
        // 提取 <title> 置顶（模型最先看到页面主题）
        const tm = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = tm ? tm[1].replace(/\s+/g, ' ').trim() : '';
        // HTML → 纯文本：先剥结构噪音块，再转换，最后行级去导航
        const text = body
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<(nav|header|footer|aside|form|button|select|iframe)[\s\S]*?<\/\1>/gi, ' ') // 布局噪音块
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/table)\b[^>]*>/gi, '\n')
          .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' ') // 表格单元格同行排布（天气/数据表保留结构）
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/[ \t]+/g, ' ')
          .split('\n').map(l => l.trim()).filter(l => !isNoiseLine(l)).join('\n')
          .replace(/\n{2,}/g, '\n');
        const cleaned = dropMenuBlocks(text).replace(/\n{2,}/g, '\n').trim();
        const sliced = offset > 0
          ? cleaned.slice(offset, offset + maxLen) + (cleaned.length > offset + maxLen ? '\n…（还有后续，增大 offset 继续）' : '')
          : cleaned.slice(0, maxLen) + (cleaned.length > maxLen ? `\n…（正文共 ${cleaned.length} 字符已截断，可用 offset=${maxLen} 续读或 length 调大）` : '');
        return `HTTP ${resp.status} ${ct}${title ? `\n标题：${title}` : ''}\n${sliced || '（无内容）'}`;
      }
      const text = body.length > maxLen ? body.slice(offset, offset + maxLen) + '…（超长已截断）' : body.slice(offset);
      return `HTTP ${resp.status} ${ct}\n${text || '（无内容）'}`;
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? '请求超时（15 秒）' : String((e && e.message) || e);
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
    }
  }
};
