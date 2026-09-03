// @name probe
// @desc HTTP 探测（冒烟验证）：请求 URL 断言状态码/响应包含/关键元素（title/h1），HTML 交付物的运行时验证。支持 expect 多断言一次判定
// @essential false

module.exports = {
  params: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标 URL（http/https）' },
      expect_status: { type: 'number', description: '期望状态码（默认 200）' },
      expect_contains: { type: 'string', description: '期望响应体包含的文本（可选）' },
      expect_title: { type: 'string', description: '期望 HTML <title> 包含的文本（可选，仅 HTML 响应）' },
      expect_h1: { type: 'string', description: '期望 <h1> 包含的文本（可选，仅 HTML 响应）' },
      method: { type: 'string', enum: ['GET', 'HEAD'], description: '请求方法（默认 GET；HEAD 只看状态码）' }
    },
    required: ['url']
  },
  run: async (args, ctx) => {
    const rawUrl = String(args.url || '').trim();
    if (!/^https?:\/\/\S+$/.test(rawUrl)) throw new Error(`URL 不合法：${rawUrl}（需 http:// 或 https:// 开头）`);
    // 安全边界：仅允许环回/内网地址（本地交付物冒烟），公网抓取走 fetch 插件
    let host = '';
    try { host = new URL(rawUrl).hostname; } catch { throw new Error(`URL 解析失败：${rawUrl}`); }
    const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host);
    if (!isLocal) throw new Error(`probe 仅支持本地/内网地址（收到 ${host}）；公网页面抓取请用 fetch 插件`);
    // 本机服务地址自动改写：localhost 常见坑是 IPv6 解析失败，强制 127.0.0.1
    const url = rawUrl.replace(/^(http):\/\/localhost/i, '$1://127.0.0.1').replace(/^(https):\/\/localhost/i, '$1://127.0.0.1');

    const method = String(args.method || 'GET').toUpperCase();
    const expectStatus = Number(args.expect_status) || 200;
    const t0 = Date.now();
    let resp, body = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      resp = await fetch(url, { method, signal: controller.signal, redirect: 'manual' });
      if (method !== 'HEAD') body = await resp.text().catch(() => '');
    } catch (e) {
      clearTimeout(timer);
      const msg = /abort/i.test(e.name + e.message) ? '10 秒超时（服务未启动或端口不通）' : e.message.slice(0, 120);
      throw new Error(`探测失败 ${url}：${msg}`);
    }
    clearTimeout(timer);
    const ms = Date.now() - t0;

    const results = [];
    let pass = 0;
    const check = (ok, label) => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (ok) pass++; };
    check(resp.status === expectStatus, `状态码 ${resp.status}（期望 ${expectStatus}）`);
    if (args.expect_contains) check(body.includes(String(args.expect_contains)), `响应包含 "${String(args.expect_contains).slice(0, 50)}"`);
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const h1 = (body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    if (args.expect_title) {
      if (!title) check(false, '<title> 不存在（响应可能不是 HTML）');
      else check(title.includes(String(args.expect_title)), `<title> 含 "${args.expect_title}"（实际：${title.trim().slice(0, 60)}）`);
    }
    if (args.expect_h1) {
      if (!h1) check(false, '<h1> 不存在');
      else check(h1.includes(String(args.expect_h1)), `<h1> 含 "${args.expect_h1}"（实际：${h1.trim().slice(0, 60)}）`);
    }
    const contentType = resp.headers.get('content-type') || '未知';
    const all = pass === results.length;
    return [
      `探测 ${method} ${url}（${ms}ms，Content-Type: ${contentType}）`,
      `判定：${all ? 'PASS' : 'FAIL'}（${pass}/${results.length} 项通过）`,
      ...results.map(r => '- ' + r)
    ].join('\n');
  }
};
