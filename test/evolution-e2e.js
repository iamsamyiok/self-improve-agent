// Evolution 端到端回归测试：直连 LLM Meta-Agent（无 opencode CLI）+ 异步 worker A/B + judge + promote
// 零依赖自包含：内置 mock OpenAI 兼容 LLM（SSE），数据/工作区落在 os.tmpdir，可重复运行
// 运行：node test/evolution-e2e.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 数据隔离（必须在 require lib/evolution 前设置） ----------
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hwj-evo-e2e-'));
process.env.DUAL_AGENT_DATA = path.join(T, 'data');
process.env.DUAL_AGENT_WS_ROOT = path.join(T, 'workspaces');

// ---------- mock OpenAI 兼容 LLM（SSE 流式） ----------
function sse(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}
const contentEv = (text) => ({ choices: [{ delta: { content: text } }] });
const usageEv = { choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch { /* 忽略 */ }
    const sys = String((j.messages && j.messages[0] && j.messages[0].content) || '');
    const last = j.messages && j.messages[j.messages.length - 1];
    // Meta-Agent 提议（直连 LLM 路径）
    if (sys.includes('Self-Improvement Meta-Agent')) {
      return sse(res, [
        contentEv('```json\n'),
        contentEv('{"type":"prompt","target":"delivery","reason":"近期任务交付说明偏简略","hypothesis":"注入交付说明纪律可提升交付完整度","change":"交付总结必须包含：产出路径、关键内容摘要、验证结果。","expectedDelta":0.05}'),
        contentEv('\n```'),
        usageEv
      ]);
    }
    // Evaluator judge
    if (sys.includes('Agent benchmark evaluator')) {
      return sse(res, [contentEv('{"baseline":0.5,"candidate":0.8,"reason":"mock judge: candidate 覆盖交付要求"}'), usageEv]);
    }
    // 意图抽取
    if (sys.includes('需求分析器')) {
      return sse(res, [contentEv('{"task":"创建 result.txt 且包含 done","goals":["写入文件"],"deliverables":[{"path":"result.txt","criterion":"包含 done"}],"constraints":[],"acceptance":["result.txt 存在且包含 done"]}'), usageEv]);
    }
    // 内层 Agent（带 tools）：首轮发工具调用，工具结果回来后给最终回答
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

// ---------- 断言 ----------
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok  ${name}`);
  else { failed++; console.error(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`); }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const evolution = require('../lib/evolution');
  const outer = require('../lib/outer');

  const DATA = process.env.DUAL_AGENT_DATA;
  fs.mkdirSync(path.join(DATA, 'evolution', 'benchmarks'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'evolution', 'experiments'), { recursive: true });
  fs.mkdirSync(path.join(process.env.DUAL_AGENT_WS_ROOT, 'default'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
    inner: { base_url: `http://127.0.0.1:${PORT}/v1`, api_key: 'mock-key', model: 'mock-model' }
  }, null, 2));

  // 3 个 benchmark（满足 MIN_CASES=3），交付物与 mock 内层行为一致
  for (let i = 1; i <= 3; i++) {
    const rec = {
      id: `b-test-${i}`,
      task: `创建 result.txt（第 ${i} 号样例），内容包含 done`,
      acceptance: ['result.txt 存在且包含 done'],
      deliverables: [{ path: 'result.txt' }],
      baseline: { finalText: '', artifacts: [], signature: 'seed' },
      createdAt: new Date(Date.now() + i).toISOString(),
      sourceWorkspace: 'default'
    };
    fs.writeFileSync(path.join(DATA, 'evolution', 'benchmarks', `b-test-${i}.json`), JSON.stringify(rec, null, 2));
  }

  console.log('== Evolution e2e：直连 LLM Meta-Agent + 异步 worker 闭环 ==');
  check('opencode CLI 未安装（回退路径前提）', !(await outer.detectOpencode()));

  const r = await evolution.runEvolution({ promote: true, cases: 3, timeoutMs: 60000 });
  check('runEvolution ok', r.ok === true, JSON.stringify(r).slice(0, 300));
  check('stage=promoted', r.stage === 'promoted', 'stage=' + r.stage);
  check('统计门槛通过 pass=true', !!(r.summary && r.summary.pass === true), JSON.stringify(r.summary || {}));
  check('meanDelta>0', !!(r.summary && r.summary.meanDelta > 0), String(r.summary && r.summary.meanDelta));

  const expDir = path.join(DATA, 'evolution', 'experiments', r.experiment);
  const proposal = JSON.parse(fs.readFileSync(path.join(expDir, 'proposal.json'), 'utf8'));
  check('proposal 来自直连 LLM 且为 prompt mutation', proposal.type === 'prompt' && !!proposal.change);
  const decision = JSON.parse(fs.readFileSync(path.join(expDir, 'decision.json'), 'utf8'));
  check('promotion.ok=true', !!(decision.promotion && decision.promotion.ok));
  for (const c of ['b-test-1', 'b-test-2', 'b-test-3']) {
    check(`case ${c} result.json`, fs.existsSync(path.join(expDir, 'cases', c, 'result.json')));
  }
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'evolution', 'state.json'), 'utf8'));
  check('state.json 晋级 version=1', Number(state.version) === 1, JSON.stringify(state));
  check('system-patch.txt 晋级落盘', fs.existsSync(path.join(DATA, 'evolution', 'system-patch.txt')));
  check('leaderboard.json 有记录', JSON.parse(fs.readFileSync(path.join(DATA, 'evolution', 'leaderboard.json'), 'utf8')).length === 1);
  const hist = evolution.history(10);
  check('history() 可查询且 promoted=true', hist.length === 1 && hist[0].explanation && hist[0].explanation.promoted === true);
  check('status().benchmarks=3', evolution.status().benchmarks === 3);

  server.close();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nevolution e2e: all passed');
  process.exit(0);
}

main().catch((e) => { console.error('E2E ERROR:', e); server.close(); process.exit(1); });
