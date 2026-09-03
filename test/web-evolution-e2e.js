// Web 路径自进化链路端到端验证：
// /api/inner/chat 任务 ×3 → 意图抽取 → 交付核验 → recordBenchmark → 自动 Evolution → promote
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hwj-web-evo-'));
const DATA = path.join(T, 'data');
const WSROOT = path.join(T, 'workspaces');
// 随机空闲端口，避免并行测试冲突
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
};

// ---------- mock LLM（SSE，复用 e2e 语义） ----------
function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const contentEv = (t) => ({ choices: [{ delta: { content: t } }] });
const usageEv = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const sys = String((j.messages && j.messages[0] && j.messages[0].content) || '');
    const last = j.messages && j.messages[j.messages.length - 1];
    if (sys.includes('Self-Improvement Meta-Agent')) {
      return sse(res, [contentEv('{"type":"prompt","target":"delivery","reason":"web 路径验证","hypothesis":"交付说明纪律提升完整度","change":"交付总结包含路径、摘要、验证结果。","expectedDelta":0.05}'), usageEv]);
    }
    if (sys.includes('Agent benchmark evaluator')) {
      return sse(res, [contentEv('{"baseline":0.5,"candidate":0.8,"reason":"mock"}'), usageEv]);
    }
    if (sys.includes('需求分析器')) {
      return sse(res, [contentEv('{"task":"创建 result.txt 且包含 done","goals":["写入文件"],"deliverables":[{"path":"result.txt","criterion":"包含 done"}],"constraints":[],"acceptance":["result.txt 存在且包含 done"]}'), usageEv]);
    }
    if (Array.isArray(j.tools) && j.tools.length) {
      if (last && last.role === 'tool') return sse(res, [contentEv('已完成：result.txt 已写入并验证包含 done。'), usageEv]);
      const args = JSON.stringify({ path: 'result.txt', content: 'done\n' });
      return sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-mock-1', type: 'function', function: { name: 'write', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
        usageEv
      ]);
    }
    return sse(res, [contentEv('好的。'), usageEv]);
  });
});

function chatOnce(port, message) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/inner/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error('chat 超时')); }, 90000);
      res.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('"type":"done"')) { clearTimeout(timer); res.destroy(); resolve(); }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end(JSON.stringify({ message }));
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const LLM_PORT = server.address().port;
  const PORT = await freePort();
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WSROOT, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    inner: { base_url: `http://127.0.0.1:${LLM_PORT}/v1`, api_key: 'mock-key', model: 'mock-model' }
  }, null, 2));

  const web = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    env: { ...process.env, DUAL_AGENT_DATA: DATA, DUAL_AGENT_WS_ROOT: WSROOT, NO_PROXY: 'localhost,127.0.0.1', HTTP_PROXY: '', http_proxy: '' },
    stdio: 'ignore'
  });
  const waitUp = async () => {
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/`); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    throw new Error('web server 未启动');
  };
  try {
    await waitUp();
    console.log('== Web 路径自进化链路（chat → benchmark → auto evolve） ==');
    for (let i = 1; i <= 3; i++) {
      await chatOnce(PORT, `创建 result.txt（第 ${i} 号任务），内容包含 done`);
      console.log(`  .. 任务 ${i} 完成`);
    }
    // 轮询：benchmarks >= 3 且自动进化产生 promoted 实验
    let status = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try { status = JSON.parse(await (await fetch(`http://127.0.0.1:${PORT}/api/evolution/status`)).text()); } catch { continue; }
      if (status.history && status.history.length && status.history.some((h) => h.promotion && h.promotion.ok)) break;
    }
    check('3 次网页对话积累 3 个 benchmark', status && status.benchmarks >= 3, JSON.stringify(status && status.benchmarks));
    check('自动进化已触发并完成实验', status && status.history.length >= 1, JSON.stringify((status && status.history || []).length));
    check('实验自动晋级 promoted', !!(status && status.history.some((h) => h.promotion && h.promotion.ok)), JSON.stringify(status && status.history && status.history[0]));
    check('进化状态 version=1', status && Number(status.state && status.state.version) === 1);
  } finally {
    web.kill('SIGKILL');
    server.close();
  }
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nweb-path evolution e2e: all passed');
  process.exit(0);
}

main().catch((e) => { console.error('E2E ERROR:', e); server.close(); process.exit(1); });
