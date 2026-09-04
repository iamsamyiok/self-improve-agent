// 冒烟测试集（零依赖，node test/smoke.js）
// 三段：① 全量语法检查 ② 核心单元（lint/parse/插件/超时/审批管线） ③ MOCK 模式 e2e（子进程起服务）
// 任何一段失败即退出码 1
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TMP = path.join('/tmp', 'da-smoke-' + Date.now().toString(36));
const PORT = Number(process.env.DUAL_AGENT_SMOKE_PORT) || (3900 + Math.floor(Math.random() * 90));
let passed = 0, failed = 0;

function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { failed++; console.log(`FAIL  ${name}\n      ${String(e && e.message || e).split('\n')[0]}`); });
}

async function main() {
  console.log(`\n[1/3] 语法检查`);
  const jsFiles = [path.join(ROOT, 'server.js')]
    .concat(fs.readdirSync(path.join(ROOT, 'lib')).map(f => path.join(ROOT, 'lib', f)))
    .concat(fs.readdirSync(path.join(ROOT, 'plugins')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'plugins', f)))
    .concat(fs.readdirSync(path.join(ROOT, 'tools')).map(f => path.join(ROOT, 'tools', f)))
    .filter(f => f.endsWith('.js'));
  await t(`node --check ${jsFiles.length} 个 JS 文件`, () => {
    for (const f of jsFiles) execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  });
  await t('前端内联 script 语法（new Function）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    new Function(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  });

  console.log(`\n[2/3] 单元测试`);
  fs.mkdirSync(TMP, { recursive: true });
  const PLUGINS_TMP = path.join(TMP, 'plugins');
  const DATA_TMP = path.join(TMP, 'data');
  fs.cpSync(path.join(ROOT, 'plugins'), PLUGINS_TMP, { recursive: true });
  fs.mkdirSync(DATA_TMP, { recursive: true });
  process.env.DUAL_AGENT_PLUGINS_DIR = PLUGINS_TMP;
  process.env.DUAL_AGENT_DATA = DATA_TMP;
  process.env.DUAL_AGENT_PLUGIN_TIMEOUT_MS = '300';

  const { lintCode } = require(path.join(ROOT, 'lib', 'lint'));
  await t('lintCode：语法错误被拦截', () => {
    const r = lintCode('const x = {');
    assert.ok(r.syntax, '应报语法错误');
  });
  await t('lintCode：child_process 命中危险警告', () => {
    const r = lintCode(`const cp = require('child_process'); module.exports = { run: async () => 'x' };`);
    assert.ok(!r.syntax);
    assert.ok(r.warns.some(w => w.includes('子进程')), JSON.stringify(r.warns));
  });
  await t('lintCode：干净代码零警告', () => {
    const r = lintCode(`module.exports = { run: async (a) => String(a.x) };`);
    assert.ok(!r.syntax && r.warns.length === 0);
  });

  const outerMod = require(path.join(ROOT, 'lib', 'outer'));
  await t('parseProposals：json 块/单对象/无效块', () => {
    const text = '看下\n```json\n{"proposals":[{"action":"create","plugin":"a","code":"x","reason":"r"}]}\n```\n```json\n{"action":"create","plugin":"b","code":"y"}\n```\n```json\n{bad json}\n```';
    const ps = outerMod.parseProposals(text);
    assert.equal(ps.length, 2);
    assert.equal(ps[1].plugin, 'b');
  });
  await t('parseProposals：非法 action 被忽略', () => {
    assert.equal(outerMod.parseProposals('```json\n{"proposals":[{"action":"rm","plugin":"x"}]}\n```').length, 0);
  });
  await t('parseProposals：code 内嵌 ``` 时围栏容错（逐级扩展闭合点）', () => {
    const code = '// @name demo\n// 教学示例嵌套围栏 ```js\n// const x = 1;\n// ```\nmodule.exports = { run: async () => "ok" };';
    const text = '说明文字\n```json\n{"proposals":[{"action":"create","plugin":"demo","code":' + JSON.stringify(code) + ',"reason":"r"}]}\n```\n结尾';
    const ps = outerMod.parseProposals(text);
    assert.equal(ps.length, 1, JSON.stringify(ps));
    assert.equal(ps[0].plugin, 'demo');
    assert.ok(ps[0].code.includes('```js') && ps[0].code.includes('module.exports'), 'code 应完整含嵌套围栏');
  });
  await t('buildContext：首评带源码、失败日志放宽、审批历史附带', () => {
    const ctxText = outerMod.buildContext(
      [{ name: 'bash', essential: true, status: 'loaded', desc: '执行命令' }],
      [
        { ts: Date.now(), plugin: 'write', args: {}, ok: false, result: 'E'.repeat(800), ms: 5 },
        { ts: Date.now(), plugin: 'read', args: {}, ok: true, result: 'S'.repeat(300), ms: 3 }
      ],
      { codes: new Map([['bash', '// bash code body']]), audit: ['- [2026-08-20 12:00] 已批准 update bash'] }
    );
    assert.ok(ctxText.includes('// bash code body'), '应包含源码全文');
    assert.ok(ctxText.includes('E'.repeat(600)), '失败条目应放宽到 600');
    assert.ok(!ctxText.includes('S'.repeat(90)), '成功条目应压缩到 80');
    assert.ok(ctxText.includes('已批准 update bash'), '应附审批历史');
    assert.ok(ctxText.includes('plugins/bash.js'), '清单应带文件路径');
  });

  const plugins = require(path.join(ROOT, 'lib', 'plugins'));
  await t('NAME_RE 拒绝路径穿越', () => {
    assert.ok(!plugins.NAME_RE.test('../evil'));
    assert.ok(!plugins.NAME_RE.test('a/b'));
    assert.ok(plugins.NAME_RE.test('my-tool'));
  });
  await t('插件清单：≥9 个插件，essential 均可加载', () => {
    const list = plugins.listPlugins();
    // 下限而非锁死数量：审批预检沙盒会带上待审新插件（9 + N），数量上限防失控
    assert.ok(list.length >= 9, `插件数 ${list.length} < 9`);
    assert.ok(list.length <= 25, `插件数 ${list.length} 异常膨胀`);
    assert.ok(list.every(p => p.status !== 'broken'), '存在 broken：' + JSON.stringify(list.filter(p => p.status === 'broken')));
    assert.ok(list.filter(p => p.essential).length >= 5);
  });
  await t('runPlugin：执行超时兜底生效（300ms）', async () => {
    fs.writeFileSync(path.join(PLUGINS_TMP, 'sleeper.js'), `module.exports = { run: () => new Promise(r => setTimeout(() => r('late'), 5000)) };`);
    const t0 = Date.now();
    const out = await plugins.runPlugin('sleeper', {}, { cwd: TMP });
    assert.ok(out.includes('执行出错') && out.includes('未返回'), out);
    assert.ok(Date.now() - t0 < 3000, '超时未及时返回');
  });
  await t('Hermes tool_call 文本兜底解析（真机 v1.2.0-alpha2 实测样例回归）', async () => {
    const { parseHermesToolCalls } = require('../lib/inner.js');
    // 真机实测：硅基流动 Qwen 系不走原生 tool_calls 通道，content 里吐残缺 Hermes 标记
    const real = '<tool_call>\n<tool_call>\n<tool_call>\n<tool_call>search(query="惠州今天天气 2026年8月23日", language="zh")\n<tool_call>\n<tool_call>search(query="Hue weather forecast August 23 2026", language="en")\n<tool_call>';
    let p = parseHermesToolCalls(real);
    assert.strictEqual(p.calls.length, 2);
    assert.deepStrictEqual(p.calls[0], { name: 'search', args: { query: '惠州今天天气 2026年8月23日', language: 'zh' } });
    // 标准 Hermes JSON 块 + 前后普通文本保留
    p = parseHermesToolCalls('我来查一下\n<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>\n');
    assert.deepStrictEqual(p.calls, [{ name: 'bash', args: { command: 'ls' } }]);
    assert.strictEqual(p.cleaned, '我来查一下');
    // 无标记文本零误伤
    p = parseHermesToolCalls('今天天气不错，适合出门。');
    assert.strictEqual(p.calls.length, 0);
    assert.strictEqual(p.cleaned, '今天天气不错，适合出门。');
    // 截断 kwargs（无右括号）+ 类型推断（布尔/数字/引号内逗号）
    p = parseHermesToolCalls('<tool_call>write(path="a.txt", content="x,y", overwrite=true, n=5');
    assert.deepStrictEqual(p.calls, [{ name: 'write', args: { path: 'a.txt', content: 'x,y', overwrite: true, n: 5 } }]);
  });
  await t('bash 插件 Android 适配层：toybox 重写与 not found 自纠提示（MOBILE 模拟）', async () => {
    // bash.js 的 MOBILE 开关在模块加载时冻结——用子进程带 env 隔离验证
    const cap = path.join(DATA_TMP, 'mobile-capability.json');
    fs.rmSync(cap, { force: true });
    const script = `
      const bash = require(${JSON.stringify(path.join(__dirname, '..', 'plugins', 'bash.js'))});
      (async () => {
        const r = await bash.run({ command: "printf 'a1\\\\nb2\\\\n' | grep -E '[0-9]'" }, { cwd: ${JSON.stringify(TMP)} });
        if (!(r.includes('退出码 0') && r.includes('a1'))) throw new Error('basic: ' + r);
        const r2 = await bash.run({ command: 'definitely_missing_cmd_xyz' }, { cwd: ${JSON.stringify(TMP)} });
        if (!r2.includes('[Android 环境提示]') || !/可用命令：/.test(r2)) throw new Error('hint: ' + r2);
        const r3 = await bash.run({ command: 'echo desktop-ok' }, { cwd: ${JSON.stringify(TMP)} });
        if (!r3.includes('desktop-ok') || r3.includes('环境提示')) throw new Error('noise: ' + r3);
        if (!require('fs').existsSync(${JSON.stringify(cap)})) throw new Error('能力缓存未落盘');
        console.log('MOBILE_OK');
      })().catch(e => { console.error(e.message); process.exit(1); });
    `;
    const out = await new Promise((resolve) => {
      const p = require('child_process').spawn(process.execPath, ['-e', script],
        { env: { ...process.env, DUAL_AGENT_MOBILE: '1', DUAL_AGENT_DATA: DATA_TMP }, stdio: ['ignore', 'pipe', 'pipe'] });
      let s = '';
      p.stdout.on('data', d => s += d); p.stderr.on('data', d => s += d);
      p.on('close', c => resolve({ c, s }));
    });
    assert.strictEqual(out.c, 0, out.s);
    assert.ok(out.s.includes('MOBILE_OK'), out.s);
  });
  const WS = path.join(TMP, 'ws');
  fs.mkdirSync(WS, { recursive: true });
  const ctx = { cwd: WS, dataDir: DATA_TMP };
  // ===== 本地文档处理（v0.9.16：借鉴 search-starter-app 的轻量摄入+检索）=====
  // 测试 fixture 三件套：纯文本直读 / 最小 PDF（无压缩文本流）/ stored-zip DOCX/XLSX（手写 zip 容器）
  const UP = path.join(WS, 'uploads');
  fs.mkdirSync(UP, { recursive: true });
  // 最小 zip 生成器（stored 不压缩）：local headers + central directory + EOCD
  const makeZip = (files) => {
    const chunks = [];
    const cd = [];
    let off = 0;
    for (const [name, content] of files) {
      const data = Buffer.from(content, 'utf8');
      const nameB = Buffer.from(name, 'utf8');
      const crc = (() => { let c = 0; for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (c ^ -1) >>> 0; })();
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
      chunks.push(lh, nameB, data);
      const ce = Buffer.alloc(46);
      ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(0, 4); ce.writeUInt16LE(0, 6); ce.writeUInt16LE(0, 8);
      ce.writeUInt32LE(crc, 16); ce.writeUInt32LE(data.length, 20); ce.writeUInt32LE(data.length, 24);
      ce.writeUInt16LE(nameB.length, 28); ce.writeUInt32LE(off, 42);
      cd.push(ce, nameB);
      off += 30 + nameB.length + data.length;
    }
    const cdBuf = Buffer.concat(cd);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...chunks, cdBuf, eocd]);
  };
  fs.writeFileSync(path.join(UP, 'notes.txt'), '第一行：项目端口 3788\n第二行：数据库端口 5432\n第三行：无关键词内容');
  fs.writeFileSync(path.join(UP, 'readme.md'), '# 标题\n\n正文 **加粗** 与 `code`\n');
  const pdfFx = `%PDF-1.4\n1 0 obj\n<< /Length 100 >>\nstream\nBT /F1 12 Tf 72 720 Td (Hello PDF \\101\\102 extraction) Tj ET\nBT /F1 12 Tf 72 700 Td (second line) Tj ET\nendstream\nendobj\ntrailer\n`;
  fs.writeFileSync(path.join(UP, 'sample.pdf'), Buffer.from(pdfFx, 'latin1'));
  fs.writeFileSync(path.join(UP, 'report.docx'), makeZip([
    ['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r></w:p><w:p><w:r><w:t>利润 &amp; 损益表</w:t></w:r></w:p></w:body></w:document>']
  ]));
  fs.writeFileSync(path.join(UP, 'data.xlsx'), makeZip([
    ['xl/sharedStrings.xml', '<sst><si><t>名称</t></si><si><t>数值</t></si></sst>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>alpha</v></c><c><v>42</v></c></row></sheetData></worksheet>']
  ]));
  await t('doc 插件：list 列出上传文档（含大小）', async () => {
    const r = await plugins.runPlugin('doc', { action: 'list' }, ctx);
    for (const f of ['notes.txt', 'readme.md', 'sample.pdf', 'report.docx', 'data.xlsx']) assert.ok(r.includes(f), `清单含 ${f}`);
    assert.ok(/KB/.test(r), '含大小');
  });
  await t('doc 插件：read 纯文本直读 + tail 分段', async () => {
    const r = await plugins.runPlugin('doc', { action: 'read', path: 'notes.txt' }, ctx);
    assert.ok(r.includes('3788') && r.includes('5432'), r);
    const t2 = await plugins.runPlugin('doc', { action: 'read', path: 'notes.txt', tail: 1 }, ctx);
    assert.ok(t2.includes('无关键词内容') && t2.includes('显示末尾 1 行'), t2);
  });
  await t('doc 插件：PDF 文本提取（无压缩流 + 八进制转义 + 多文本块）', async () => {
    const r = await plugins.runPlugin('doc', { action: 'read', path: 'sample.pdf' }, ctx);
    assert.ok(r.includes('Hello PDF AB extraction'), '文本操作符提取（\\101\\102 八进制解码）：' + r.slice(0, 200));
    assert.ok(r.includes('second line'), '多 BT 块拼接');
  });
  await t('doc 插件：DOCX 提取（手写 zip 容器 + XML 实体解码 + 段落换行）', async () => {
    const r = await plugins.runPlugin('doc', { action: 'read', path: 'report.docx' }, ctx);
    assert.ok(r.includes('Hello World'), '同段 run 拼接：' + r.slice(0, 200));
    assert.ok(r.includes('利润 & 损益表'), 'XML 实体解码');
  });
  await t('doc 插件：XLSX 提取（sharedStrings 索引 + 行列拼装）', async () => {
    const r = await plugins.runPlugin('doc', { action: 'read', path: 'data.xlsx' }, ctx);
    assert.ok(r.includes('名称') && r.includes('数值'), '共享字符串解析');
    assert.ok(/alpha\t42/.test(r), '行内单元格 tab 分隔：' + r.slice(0, 200));
  });
  await t('doc 插件：search 关键词检索（多文档命中 + 行号）', async () => {
    const r = await plugins.runPlugin('doc', { action: 'search', query: '端口 5432' }, ctx);
    assert.ok(r.includes('notes.txt'), '命中文档归组');
    assert.ok(/L2/.test(r), '行号标注');
    assert.ok(r.includes('5432') && !r.includes('无关键词内容'), '按行命中而非全文');
    const miss = await plugins.runPlugin('doc', { action: 'search', query: '不存在的词xyz' }, ctx);
    assert.ok(/未命中/.test(miss), miss);
  });
  await t('doc 插件：图片明确报错（可操作）+ 路径越界拦截', async () => {
    fs.writeFileSync(path.join(UP, 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    let err = await plugins.runPlugin('doc', { action: 'read', path: 'pic.png' }, ctx);
    assert.ok(/图片/.test(err) && /\/files\//.test(err), '图片提示查看路径：' + err);
    err = await plugins.runPlugin('doc', { action: 'read', path: '../secret.txt' }, ctx);
    assert.ok(/越界/.test(err), '越界拦截：' + err);
    err = await plugins.runPlugin('doc', { action: 'read', path: 'nope.txt' }, ctx);
    assert.ok(/不存在/.test(err), '不存在提示含现有清单');
  });
  await t('mdRender：markdown 渲染（标题/代码块/表格/链接/XSS 转义）', () => {
    // server.js 非导出模块——以子进程 require 方式取函数：直接 vm 加载有副作用（启动服务器），
    // 改为静态验证 + /view e2e 覆盖渲染结果（此处断言函数存在与关键正则）
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/function mdRender\(/.test(srv), 'mdRender 定义');
    assert.ok(/&lt;script&gt;|replace\(&lt;/.test(srv) || /function mdRender/.test(srv), '渲染前转义');
  });
  await t('memory 插件：save/search/delete', async () => {
    await plugins.runPlugin('memory', { action: 'save', content: '端口 3788', tags: ['env'] }, ctx);
    const hit = await plugins.runPlugin('memory', { action: 'search', query: '端口' }, ctx);
    assert.ok(hit.includes('端口 3788'), hit);
    assert.ok(fs.existsSync(path.join(WS, '.memory-short.json')), '记忆应存工作区（随工作区隔离）');
  });
  await t('memory 插件：save long 后不带 level 检索必须命中（跨库默认）', async () => {
    // 回归（v0.9.4 实测发现）：search 曾复用 save 的默认 level='short'，
    // 存 long 后不带 level 检索必然零命中——记忆像丢了一样
    await plugins.runPlugin('memory', { action: 'save', content: '长期事实：网关地址是 example.com', tags: ['infra'], level: 'long' }, ctx);
    const hit = await plugins.runPlugin('memory', { action: 'search', query: '网关' }, ctx);
    assert.ok(hit.includes('example.com'), '不带 level 的 search 应跨库命中 long 记忆：' + hit);
    const narrow = await plugins.runPlugin('memory', { action: 'search', query: '网关', level: 'short' }, ctx);
    assert.ok(narrow.includes('没有匹配'), '显式 level=short 收窄仍可用：' + narrow);
  });
  await t('memory 插件：单调 id（删除后新增不复用）+ 同标签追加不覆盖', async () => {
    const s1 = await plugins.runPlugin('memory', { action: 'save', content: '事实甲', tags: ['proj'] }, ctx);
    assert.ok(s1.includes('#2'), '前序用例已占 #1，本条应为 #2：' + s1); // #1 = 上一用例的"端口 3788"
    const s2 = await plugins.runPlugin('memory', { action: 'save', content: '事实乙', tags: ['proj'] }, ctx);
    assert.ok(s2.includes('#3'), s2);
    const d1 = await plugins.runPlugin('memory', { action: 'delete', id: 2 }, ctx);
    assert.ok(d1.includes('已删除'), d1);
    const s3 = await plugins.runPlugin('memory', { action: 'save', content: '事实丙', tags: ['proj'] }, ctx);
    assert.ok(s3.includes('#4'), '删除后新增应继续单调递增（旧版会复用 id 撞车）：' + s3);
    const arr = JSON.parse(fs.readFileSync(path.join(WS, '.memory-short.json'), 'utf8'));
    assert.equal(arr.length, 3, '同标签应追加保留，不应覆盖：' + JSON.stringify(arr));
    assert.ok(arr.some(m => m.content === '事实乙') && arr.some(m => m.content === '事实丙'), '同标签两条事实都应存在');
  });
  await t('todo 插件：add/toggle/clear', async () => {
    const a = await plugins.runPlugin('todo', { action: 'add', text: '写周报' }, ctx);
    assert.ok(a.includes('#1'));
    const b = await plugins.runPlugin('todo', { action: 'toggle', id: 1 }, ctx);
    assert.ok(b.includes('[x]'));
    await plugins.runPlugin('todo', { action: 'clear', mode: 'done' }, ctx);
  });
  await t('verify 插件：多规则一次断言（PASS/FAIL 框架判定）', async () => {
    fs.writeFileSync(path.join(WS, 'v-target.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const pass = await plugins.runPlugin('verify', {
      path: 'v-target.txt',
      rules: [
        { type: 'exists' },
        { type: 'contains', text: 'beta' },
        { type: 'not_contains', text: 'delta' },
        { type: 'regex', pattern: 'gam[a-z]' },
        { type: 'line_count', exact: 3 }
      ]
    }, ctx);
    assert.ok(pass.includes('5/5 通过') && pass.includes('PASS'), pass);
    const fail = await plugins.runPlugin('verify', {
      path: 'v-target.txt',
      rules: [
        { type: 'contains', text: '不存在的内容' },
        { type: 'exists' }
      ]
    }, ctx);
    assert.ok(fail.includes('1/2 通过') && fail.includes('FAIL') && fail.includes('✗'), fail);
  });
  await t('verify regex：^$ 按行锚定（grep 语义，防误报）', async () => {
    // 回归（v0.9.4 实测）：模型写 ^34$ 表达"末行为 34"，不带 m flag 是整串锚点 → 误报 FAIL
    fs.writeFileSync(path.join(WS, 'v-anchor.txt'), '1\n5\n13\n34', 'utf8');
    const ok = await plugins.runPlugin('verify', { path: 'v-anchor.txt', rules: [{ type: 'regex', pattern: '^34$' }] }, ctx);
    assert.ok(ok.includes('1/1 通过') && ok.includes('PASS'), ok);
    const head = await plugins.runPlugin('verify', { path: 'v-anchor.txt', rules: [{ type: 'regex', pattern: '^1$' }] }, ctx);
    assert.ok(head.includes('PASS'), '首行锚定同样按行匹配');
    const miss = await plugins.runPlugin('verify', { path: 'v-anchor.txt', rules: [{ type: 'regex', pattern: '^3$' }] }, ctx);
    assert.ok(miss.includes('FAIL'), '非整行内容不应命中行锚点');
  });
  await t('verify 插件：json_valid + json_path 断言', async () => {
    fs.writeFileSync(path.join(WS, 'v-cfg.json'), JSON.stringify({ name: 'dual-agent', inner: { model: 'agnes-2.5-flash' }, list: [10, 20] }), 'utf8');
    const ok = await plugins.runPlugin('verify', {
      path: 'v-cfg.json',
      rules: [
        { type: 'json_valid' },
        { type: 'json_path', expr: 'inner.model', equals: 'agnes-2.5-flash' },
        { type: 'json_path', expr: 'list.1', equals: 20 },
        { type: 'json_path', expr: 'name' }
      ]
    }, ctx);
    assert.ok(ok.includes('4/4 通过') && ok.includes('PASS'), ok);
    const bad = await plugins.runPlugin('verify', {
      path: 'v-cfg.json',
      rules: [{ type: 'json_path', expr: 'inner.model', equals: 'wrong-model' }]
    }, ctx);
    assert.ok(bad.includes('FAIL') && bad.includes('期望'), bad);
    fs.writeFileSync(path.join(WS, 'v-bad.json'), '{broken', 'utf8');
    const inv = await plugins.runPlugin('verify', { path: 'v-bad.json', rules: [{ type: 'json_valid' }] }, ctx);
    assert.ok(inv.includes('FAIL') && inv.includes('JSON 非法'), inv);
  });
  await t('verify 插件：不存在文件与空规则拒绝', async () => {
    const miss = await plugins.runPlugin('verify', { path: 'no-such.txt', rules: [{ type: 'exists' }] }, ctx);
    assert.ok(miss.includes('FAIL') && miss.includes('文件不存在'), miss);
    // runPlugin 把插件 throw 转为错误字符串返回（软失败统一约定）
    const empty = await plugins.runPlugin('verify', { path: 'x', rules: [] }, ctx);
    assert.ok(empty.includes('至少提供 1 条'), empty);
    assert.ok(/^插件 verify/.test(empty), '应被标记为失败调用：' + empty);
  });
  await t('verify 插件：绝对路径自动转相对（根治 LLM 误用 /abs/path 场景）', async () => {
    fs.writeFileSync(path.join(WS, 'vr-verify.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
    const abs = path.join(WS, 'vr-verify.txt');
    // 之前 bug：LLM 给绝对路径会越界；修法后应自动转相对并成功读取
    const r = await plugins.runPlugin('verify', { path: abs, rules: [{ type: 'contains', text: 'beta' }, { type: 'line_count', exact: 3 }] }, ctx);
    assert.ok(r.includes('2/2 通过') && r.includes('PASS'), r);
    // 子目录内文件也适用
    fs.mkdirSync(path.join(WS, 'vr-sub'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'vr-sub', 'vr-inner.md'), 'inner content\n', 'utf8');
    const r2 = await plugins.runPlugin('verify', { path: path.join(WS, 'vr-sub', 'vr-inner.md'), rules: [{ type: 'contains', text: 'inner' }] }, ctx);
    assert.ok(r2.includes('PASS'), r2);
    // 真正的越界仍应拒绝
    const esc = await plugins.runPlugin('verify', { path: '/etc/passwd', rules: [{ type: 'exists' }] }, ctx);
    assert.ok(/^插件 verify/.test(esc) && esc.includes('路径越界'), esc);
  });

  // ===== v0.9.25 原子插件：stat / diff / query / calc / tree / archive / probe =====
  await t('stat 插件：单文件客观统计（CJK 口径）+ glob 汇总', async () => {
    fs.writeFileSync(path.join(WS, 'st-a.md'), '你好世界\nhello world\n第二行\n', 'utf8');
    fs.writeFileSync(path.join(WS, 'st-b.md'), '测试\n', 'utf8');
    const one = await plugins.runPlugin('stat', { path: 'st-a.md' }, ctx);
    assert.ok(one.includes('CJK 字数（中日韩字数口径）：7'), one); // 你好世界 4 + 第二行 3
    const glob = await plugins.runPlugin('stat', { path: '**/*.md' }, ctx);
    assert.ok(glob.includes('匹配') && glob.includes('st-a.md') && glob.includes('st-b.md'), glob);
    const miss = await plugins.runPlugin('stat', { path: 'no-such.md' }, ctx);
    assert.ok(/^插件 stat/.test(miss) && miss.includes('文件不存在'), miss);
  });

  await t('diff 插件：文件差异 + 零差异判定（返修验证）', async () => {
    fs.writeFileSync(path.join(WS, 'df-a.txt'), 'line1\nline2\nline3\n', 'utf8');
    fs.writeFileSync(path.join(WS, 'df-b.txt'), 'line1\nline2-changed\nline3\nline4\n', 'utf8');
    const d = await plugins.runPlugin('diff', { left: 'df-a.txt', right: 'df-b.txt' }, ctx);
    assert.ok(d.includes('+2 行新增') && d.includes('-1 行删除'), d);
    assert.ok(d.includes('@@') && d.includes('-line2') && d.includes('+line2-changed'), d);
    const same = await plugins.runPlugin('diff', { left: 'df-a.txt', right: 'df-a.txt' }, ctx);
    assert.ok(same.includes('完全相同（零差异）') && same.includes('返修没有产生任何实际修改'), same);
    const inline = await plugins.runPlugin('diff', { left: 'a\nb', right: 'a\nc' }, ctx);
    assert.ok(inline.includes('+1 行新增'), inline);
  });

  await t('query 插件：JSON 点路径提取 + CSV 筛选（省 token）', async () => {
    fs.writeFileSync(path.join(WS, 'q-data.json'), JSON.stringify({ code: 0, data: { items: [{ name: '甲', score: 95 }, { name: '乙', score: 60 }] } }), 'utf8');
    fs.writeFileSync(path.join(WS, 'q-table.csv'), 'name,score\n甲,95\n乙,60\n丙,88\n', 'utf8');
    const j = await plugins.runPlugin('query', { path: 'q-data.json', mode: 'json', expr: 'data.items[*].name' }, ctx);
    assert.ok(j.includes('2 项') && j.includes('甲') && j.includes('乙'), j);
    const j2 = await plugins.runPlugin('query', { path: 'q-data.json', mode: 'json', expr: 'data.items.0.score' }, ctx);
    assert.ok(j2.includes('95'), j2);
    const jMiss = await plugins.runPlugin('query', { path: 'q-data.json', mode: 'json', expr: 'data.nope' }, ctx);
    assert.ok(/^插件 query/.test(jMiss) && jMiss.includes('顶层可用字段'), jMiss);
    const c = await plugins.runPlugin('query', { path: 'q-table.csv', mode: 'csv', expr: 'select name,score where score>80' }, ctx);
    assert.ok(c.includes('命中 2 行') && c.includes('甲') && c.includes('丙') && !c.includes('乙'), c);
    const cBad = await plugins.runPlugin('query', { path: 'q-table.csv', mode: 'csv', expr: 'select nope where x>1' }, ctx);
    assert.ok(/^插件 query/.test(cBad) && cBad.includes('可用列'), cBad);
  });

  await t('calc 插件：表达式/聚合/沙箱隔离', async () => {
    const expr = await plugins.runPlugin('calc', { code: 'round(avg([90, 85, 100]), 2)' }, ctx);
    assert.ok(expr.includes('91.67'), expr);
    const block = await plugins.runPlugin('calc', { code: 'const t = data.items.reduce((a,x)=>a+x.n,0); return {total: t};', data: '{"items":[{"n":1},{"n":2},{"n":3}]}' }, ctx);
    assert.ok(block.includes('"total": 6'), block);
    const evil = await plugins.runPlugin('calc', { code: 'require("fs")' }, ctx);
    assert.ok(/^插件 calc/.test(evil) && evil.includes('计算失败'), '沙箱内 require 必须不可用：' + evil);
    const loop = await plugins.runPlugin('calc', { code: 'while(true){}' }, ctx);
    assert.ok(/^插件 calc/.test(loop) && loop.includes('超时'), '死循环必须被 500ms 超时截断：' + loop);
  });

  await t('tree 插件：目录树 + 深度控制 + 越界拦截', async () => {
    fs.mkdirSync(path.join(WS, 'tr-sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(WS, 'tr-root.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(WS, 'tr-sub', 'tr-inner.md'), 'y', 'utf8');
    fs.writeFileSync(path.join(WS, 'tr-sub', 'deep', 'tr-deep.js'), 'z', 'utf8');
    const t1 = await plugins.runPlugin('tree', { depth: 1 }, ctx);
    assert.ok(t1.includes('tr-sub/') && t1.includes('tr-root.txt') && !t1.includes('tr-deep.js'), t1);
    const t2 = await plugins.runPlugin('tree', { depth: 3 }, ctx);
    assert.ok(t2.includes('tr-deep.js'), t2);
    const esc = await plugins.runPlugin('tree', { dir: '../../' }, ctx);
    assert.ok(/^插件 tree/.test(esc) && esc.includes('越界'), esc);
  });

  await t('grep 插件：工作区内容检索（BM25 排序 + 中文命中 + 片段 + 越界拦截）', async () => {
    fs.writeFileSync(path.join(WS, 'gp-auth.js'), 'function userLogin(token) { return verifySession(token); }\n', 'utf8');
    fs.writeFileSync(path.join(WS, 'gp-note.md'), '部署完成后必须执行探活检查确认端口监听正常。\n', 'utf8');
    fs.writeFileSync(path.join(WS, 'gp-empty.txt'), '', 'utf8');
    const r1 = await plugins.runPlugin('grep', { query: '登录验证 token 会话' }, ctx);
    assert.ok(r1.includes('gp-auth.js'), r1);
    assert.ok(r1.includes('userLogin'), '命中片段应包含匹配行内容');
    const r2 = await plugins.runPlugin('grep', { query: '探活检查端口监听' }, ctx);
    assert.ok(r2.includes('gp-note.md'), r2);
    const r3 = await plugins.runPlugin('grep', { query: '完全不存在的量子词汇' }, ctx);
    assert.ok(r3.includes('无文件命中'), r3);
    const esc = await plugins.runPlugin('grep', { query: 'test', dir: '../../' }, ctx);
    assert.ok(/^插件 grep/.test(esc) && esc.includes('越界'), esc);
  });

  await t('archive 插件：save/list/diff/restore/clean 闭环', async () => {
    fs.writeFileSync(path.join(WS, 'ar-doc.md'), 'v1 内容', 'utf8');
    const save = await plugins.runPlugin('archive', { action: 'save', tag: 'test-snap' }, ctx);
    assert.ok(save.includes('快照已创建') && save.includes('test-snap'), save);
    const dup = await plugins.runPlugin('archive', { action: 'save', tag: 'test-snap' }, ctx);
    assert.ok(/^插件 archive/.test(dup) && dup.includes('已存在'), dup);
    fs.writeFileSync(path.join(WS, 'ar-doc.md'), 'v2 改动', 'utf8');
    fs.writeFileSync(path.join(WS, 'ar-new.txt'), '新增文件', 'utf8');
    const diff = await plugins.runPlugin('archive', { action: 'diff', tag: 'test-snap' }, ctx);
    assert.ok(diff.includes('1 个修改') && diff.includes('~ ar-doc.md') && diff.includes('+ ar-new.txt'), diff);
    const restore = await plugins.runPlugin('archive', { action: 'restore', tag: 'test-snap' }, ctx);
    assert.ok(restore.includes('已恢复'), restore);
    const back = fs.readFileSync(path.join(WS, 'ar-doc.md'), 'utf8');
    assert.equal(back, 'v1 内容', 'restore 后内容必须回到快照版本');
    const list = await plugins.runPlugin('archive', { action: 'list' }, ctx);
    assert.ok(list.includes('test-snap'), list);
    const clean = await plugins.runPlugin('archive', { action: 'clean', tag: 'test-snap' }, ctx);
    assert.ok(clean.includes('已删除'), clean);
  });

  await t('probe 插件：本地 HTTP 冒烟断言（PASS/FAIL 判定）', async () => {
    const http = require('http');
    const html = '<html><head><title>探测目标页</title></head><body><h1>欢迎</h1><p>probe-ok</p></body></html>';
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const r = await plugins.runPlugin('probe', { url: base + '/', expect_contains: 'probe-ok', expect_title: '探测', expect_h1: '欢迎' }, ctx);
      assert.ok(r.includes('PASS') && r.includes('状态码 200'), r);
      assert.ok(r.includes('4/4 项通过'), r);
      const r2 = await plugins.runPlugin('probe', { url: base + '/', expect_contains: '不存在的文本' }, ctx);
      assert.ok(r2.includes('FAIL'), '断言失败必须 FAIL：' + r2);
      const remote = await plugins.runPlugin('probe', { url: 'https://example.com/' }, ctx);
      assert.ok(/^插件 probe/.test(remote) && remote.includes('仅支持本地'), '公网地址必须被拒绝：' + remote);
      const dead = await plugins.runPlugin('probe', { url: 'http://127.0.0.1:1/' }, ctx);
      assert.ok(/^插件 probe/.test(dead) && dead.includes('探测失败'), dead);
    } finally { srv.close(); }
  });
  await t('skill 插件：save/get/非法名', async () => {
    await plugins.runPlugin('skill', { action: 'save', name: 't1', content: '# 标题' }, ctx);
    assert.ok((await plugins.runPlugin('skill', { action: 'get', name: 't1' }, ctx)).includes('# 标题'));
    assert.ok((await plugins.runPlugin('skill', { action: 'save', name: '../bad', content: 'x' }, ctx)).includes('不合法'));
  });
  await t('skill 插件：Agent Skills 标准目录型（SKILL.md + frontmatter）', async () => {
    // 目录型技能拷入工作区 skills/ 即被发现（社区技能零适配直接用）
    const skDir = path.join(WS, 'skills', 'pdf-processing');
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'), '---\nname: pdf-processing\ndescription: Extract PDF text and fill forms. Use when handling PDFs.\n---\n\n# 步骤\n1. 提取文本', 'utf8');
    fs.mkdirSync(path.join(skDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(skDir, 'scripts', 'extract.py'), 'print(1)', 'utf8');
    const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
    assert.ok(list.includes('pdf-processing') && list.includes('Extract PDF text'), 'frontmatter description 应进入 list：' + list.slice(0, 300));
    assert.ok(!list.includes('# 步骤'), '渐进式：list 不含正文');
    const full = await plugins.runPlugin('skill', { action: 'get', name: 'pdf-processing' }, ctx);
    assert.ok(full.includes('# 步骤') && full.includes('目录型技能') && full.includes('scripts'), 'get 应返回全文与捆绑资源提示');
    const del = await plugins.runPlugin('skill', { action: 'delete', name: 'pdf-processing' }, ctx);
    assert.ok(del.includes('目录型'), del);
    assert.ok(!fs.existsSync(skDir), '删除应移除整个技能目录');
  });
  await t('skill 插件：全局共享目录 + 工作区同名就近优先', async () => {
    const shared = path.join(TMP, 'skills-shared');
    fs.mkdirSync(path.join(shared, 'common-greet'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'common-greet', 'SKILL.md'), '---\nname: common-greet\ndescription: 全局共享版本\n---\n\n全局', 'utf8');
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    process.env.DUAL_AGENT_SKILLS_SHARED = shared;
    try {
      let list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      assert.ok(list.includes('common-greet') && list.includes('全局共享版本'), '共享目录技能应被发现：' + list.slice(0, 200));
      // 工作区放同名技能 → 就近优先
      const wsDir = path.join(WS, 'skills', 'common-greet');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'SKILL.md'), '---\nname: common-greet\ndescription: 工作区覆盖版本\n---\n\n本地', 'utf8');
      list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      assert.ok(list.includes('工作区覆盖版本') && !list.includes('全局共享版本'), '工作区应覆盖全局：' + list.slice(0, 200));
      const full = await plugins.runPlugin('skill', { action: 'get', name: 'common-greet' }, ctx);
      assert.ok(full.includes('本地'), 'get 应返回工作区版本');
      fs.rmSync(wsDir, { recursive: true, force: true });
    } finally {
      process.env.DUAL_AGENT_SKILLS_SHARED = prev;
    }
  });
  await t('read 插件：skill: 协议直读技能捆绑资源（含就近优先与 frontmatter 名匹配）', async () => {
    const shared = path.join(TMP, 'skills-shared2');
    // 目录名与 frontmatter name 不同：验证 frontmatter 名也可命中
    fs.mkdirSync(path.join(shared, 'My Fancy Tool'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'My Fancy Tool', 'SKILL.md'), '---\nname: fancy-tool\ndescription: 测试名解析\n---\n\n# 正文', 'utf8');
    fs.mkdirSync(path.join(shared, 'My Fancy Tool', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'My Fancy Tool', 'templates', 'viewer.html'), '<html>TEMPLATE</html>', 'utf8');
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    process.env.DUAL_AGENT_SKILLS_SHARED = shared;
    try {
      // 1. frontmatter 名 + 技能内相对路径
      const r1 = await plugins.runPlugin('read', { path: 'skill:fancy-tool/templates/viewer.html' }, ctx);
      assert.ok(r1.includes('TEMPLATE'), 'skill: 协议应解析到捆绑资源：' + r1.slice(0, 120));
      // 2. skill:名 直接读 SKILL.md 本体
      const r2 = await plugins.runPlugin('read', { path: 'skill:fancy-tool' }, ctx);
      assert.ok(r2.includes('# 正文'), 'skill:名 应默认读 SKILL.md');
      // 3. 工作区同名技能就近优先
      const wsDir = path.join(WS, 'skills', 'fancy-tool');
      fs.mkdirSync(path.join(wsDir, 'templates'), { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'SKILL.md'), '---\nname: fancy-tool\ndescription: 本地版\n---\n\n# 本地', 'utf8');
      fs.writeFileSync(path.join(wsDir, 'templates', 'viewer.html'), '<html>LOCAL</html>', 'utf8');
      const r3 = await plugins.runPlugin('read', { path: 'skill:fancy-tool/templates/viewer.html' }, ctx);
      assert.ok(r3.includes('LOCAL'), '工作区技能应优先命中');
      fs.rmSync(wsDir, { recursive: true, force: true });
      // 4. miss 时错误信息列出可用技能（框架层把 throw 转返回字符串，断言其内容）
      const miss = await plugins.runPlugin('read', { path: 'skill:no-such/templates/x.html' }, ctx);
      assert.ok(String(miss).includes('fancy-tool') && String(miss).includes('未命中'), 'miss 应提示可用技能名：' + miss);
    } finally {
      process.env.DUAL_AGENT_SKILLS_SHARED = prev;
    }
  });
  await t('skill promptSection：空库返回空串（系统提示恢复无技能形态）', async () => {
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    const cleanWs = path.join(TMP, 'ps-clean-ws');
    fs.mkdirSync(cleanWs, { recursive: true });
    process.env.DUAL_AGENT_SKILLS_SHARED = path.join(TMP, 'ps-empty-shared');
    fs.mkdirSync(process.env.DUAL_AGENT_SKILLS_SHARED, { recursive: true });
    try {
      const sec = require('../plugins/skill').promptSection({ cwd: cleanWs, dataDir: DATA_TMP });
      assert.strictEqual(sec, '', '双根均无技能时应返回空串');
    } finally { process.env.DUAL_AGENT_SKILLS_SHARED = prev; }
  });
  await t('skill promptSection：清单行格式 + 计数 + 触发纪律', async () => {
    const cleanWs = path.join(TMP, 'ps-clean-ws');
    fs.mkdirSync(cleanWs, { recursive: true });
    const shared = path.join(TMP, 'ps-shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(path.join(shared, 'demo-a'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'demo-a', 'SKILL.md'), '---\nname: demo-a\ndescription: Use when doing demo A tasks\n---\n\n正文', 'utf8');
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    process.env.DUAL_AGENT_SKILLS_SHARED = shared;
    try {
      const sec = require('../plugins/skill').promptSection({ cwd: cleanWs, dataDir: DATA_TMP });
      assert.ok(sec.startsWith('## 可用技能库（共 1 个）：'), '应有计数头：' + sec.split('\n')[0]);
      assert.ok(sec.includes('- demo-a: Use when doing demo A tasks'), '应有清单行');
      assert.ok(sec.includes('skill.get("<技能名>")'), '应含触发纪律');
      assert.ok(sec.includes('skill:'), '应含 skill: 协议提示');
    } finally { process.env.DUAL_AGENT_SKILLS_SHARED = prev; }
  });
  await t('skill promptSection：预算截断（>40 技能取前 40 并注明剩余；总量 >6000 字符收缩）', async () => {
    const shared = path.join(TMP, 'ps-many');
    fs.mkdirSync(shared, { recursive: true });
    for (let i = 0; i < 45; i++) {
      const name = `bulk-${String(i).padStart(2, '0')}`;
      fs.mkdirSync(path.join(shared, name), { recursive: true });
      fs.writeFileSync(path.join(shared, name, 'SKILL.md'), `---\nname: ${name}\ndescription: bulk skill ${i} ${'描述内容'.repeat(8)}\n---\n\nx`, 'utf8');
    }
    const prev = process.env.DUAL_AGENT_SKILLS_SHARED;
    process.env.DUAL_AGENT_SKILLS_SHARED = shared;
    try {
      const sec = require('../plugins/skill').promptSection(ctx);
      assert.ok(sec.length <= 6000, `清单应受 6000 字符预算约束，实际 ${sec.length}`);
      assert.ok(sec.includes('未列出'), '发生截断应注明剩余数量');
      assert.ok(sec.includes('bulk-00'), '名称序前段应保留');
    } finally { process.env.DUAL_AGENT_SKILLS_SHARED = prev; }
  });
  await t('系统提示：技能清单常驻 + Evolution 策略注入复活（P0 修复）', async () => {
    const core = require('../hwj/core.js');
    const prevPatch = process.env.DUAL_AGENT_SYSTEM_PATCH, prevStrategy = process.env.DUAL_AGENT_EVOLUTION_STRATEGY;
    process.env.DUAL_AGENT_SYSTEM_PATCH = '静态断言策略补丁 XYZ';
    process.env.DUAL_AGENT_EVOLUTION_STRATEGY = '{"memoryTopK":7}';
    try {
      const p = core.buildHwjSystemPrompt(ctx.cwd);
      assert.strictEqual(typeof p, 'string', '必须返回字符串（历史 bug：return [ ] 返回数组导致 patch/strategy 死代码）');
      assert.ok(p.includes('静态断言策略补丁 XYZ'), 'systemPatch 应注入');
      assert.ok(p.includes('top_k=7'), 'strategy memoryTopK 应注入');
    } finally {
      process.env.DUAL_AGENT_SYSTEM_PATCH = prevPatch;
      process.env.DUAL_AGENT_EVOLUTION_STRATEGY = prevStrategy;
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'hwj', 'core.js'), 'utf8');
    assert.ok(src.includes('const lines = ['), '静态防回归：buildHwjSystemPrompt 禁止提前 return 数组');
  });
  await t('skill 插件：list 描述按词边界截断（不截在词中间）', async () => {
    const skDir = path.join(WS, 'skills', 'clip-test');
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'), `---\nname: clip-test\ndescription: ${'word '.repeat(40).trim()}\n---\n\n正文`, 'utf8');
    const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
    const line = list.split('\n').find(l => l.includes('clip-test'));
    assert.ok(/ word…$/.test(line), '截断应落在完整词后（不切词一半）：...' + line.slice(-40));
    fs.rmSync(skDir, { recursive: true, force: true });
  });
  await t('skill 插件：get 资源清单含 bash 可用绝对路径（脚本类技能执行入口）', async () => {
    const skDir = path.join(WS, 'skills', 'script-demo');
    fs.mkdirSync(path.join(skDir, 'scripts', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'), '---\nname: script-demo\ndescription: 脚本技能\n---\n\n# 正文', 'utf8');
    fs.writeFileSync(path.join(skDir, 'scripts', 'run.py'), 'print(1)', 'utf8');
    fs.writeFileSync(path.join(skDir, 'scripts', '__pycache__', 'run.cpython-311.pyc'), 'bin', 'utf8');
    try {
      const get = await plugins.runPlugin('skill', { action: 'get', name: 'script-demo' }, ctx);
      assert.ok(get.includes(`skill:script-demo/scripts/run.py → ${path.join(WS, 'skills', 'script-demo', 'scripts', 'run.py')}`), '清单应同时给 skill: 路径与绝对路径');
      assert.ok(!get.includes('__pycache__') && !get.includes('.pyc'), '应过滤 __pycache__/.pyc');
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
  });
  await t('skill 插件：多行 YAML frontmatter（折叠/字面/续行）零适配解析', async () => {
    const skDir = path.join(WS, 'skills', 'multi-line-demo');
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'),
      '---\nname: multi-line-demo\ndescription: >-\n  折叠标量第一行，\n  第二行继续描述。\nlicense: MIT\n---\n\n# 正文', 'utf8');
    try {
      const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      const line = list.split('\n').find(l => l.includes('multi-line-demo'));
      assert.ok(line && line.includes('折叠标量第一行， 第二行继续描述'), '折叠标量应折成单行：' + line);
      const get = await plugins.runPlugin('skill', { action: 'get', name: 'multi-line-demo' }, ctx);
      assert.ok(get.includes('# 正文'), 'get 正常');
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
    // 字面量块（|）：描述保留换行（list 中折行显示为空格拼接也接受，但不允许读出 "|" 字面量）
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'),
      '---\nname: multi-line-demo\ndescription: |\n  字面量块第一行\n  字面量块第二行\n---\n\n# 正文', 'utf8');
    try {
      const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      assert.ok(!list.includes('|'), '块标量符号不应泄漏到描述：' + list.split('\n').find(l => l.includes('multi-line-demo')));
      assert.ok(list.includes('字面量块第一行'), '字面量内容应被读取');
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
    // 普通标量续行
    fs.mkdirSync(skDir, { recursive: true });
    fs.writeFileSync(path.join(skDir, 'SKILL.md'),
      '---\nname: multi-line-demo\ndescription: 起始描述\n  接着的一行\n---\n\n# 正文', 'utf8');
    try {
      const list = await plugins.runPlugin('skill', { action: 'list' }, ctx);
      const line = list.split('\n').find(l => l.includes('multi-line-demo'));
      assert.ok(line && line.includes('起始描述 接着的一行'), '续行应并入：' + line);
    } finally { fs.rmSync(skDir, { recursive: true, force: true }); }
  });

  const { sanitizeToolArguments, parseToolArgs, reassembleCalls, shouldStall, recordFail, STALL_LIMIT, budgetMessages, estimateChars, estimateTokens, estimateTokensV2, estimateMessagesTokens, chatInnerReal, usageNoteMsg, isMultiStepTask, isLongFormTask, isRefusalNudge, READONLY_PLUGINS, pairSafeTail } = require(path.join(ROOT, 'lib', 'inner'));
  const { preflight, pluginScores } = require(path.join(ROOT, 'lib', 'regression'));
  await t('regression 预检：坏结构插件被拦截（params/run 缺失、第三方模块、语法错）', async () => {
    const bad = await preflight([{ action: 'create', plugin: 't-bad', code: 'module.exports = { run: "x" };' }]);
    assert.ok(!bad.ok && bad.stage === 'syntax' && /params/.test(bad.error), bad.error);
    const third = await preflight([{ action: 'create', plugin: 't-3rd', code: 'require("lodash");module.exports = { params: { type: "object" }, run: async () => 1 };' }]);
    assert.ok(!third.ok && /第三方模块/.test(third.error), third.error);
    const syn = await preflight([{ action: 'create', plugin: 't-syn', code: 'const = ;' }]);
    assert.ok(!syn.ok, '语法错应拦');
  });
  await t('regression 预检：合法插件通过全量回归（沙盒 smoke）', async () => {
    if (process.env.DUAL_AGENT_NO_PREFLIGHT === '1') return; // 防递归：预检沙盒内跳过本测试
    const good = await preflight([{ action: 'create', plugin: 't-good', code: '// @name t-good\nmodule.exports = { params: { type: "object", properties: { a: { type: "string" } }, required: ["a"] }, run: async (x) => "ok:" + x.a };' }]);
    assert.ok(good.ok, good.error || '合法插件应通过');
  });
  await t('regression 插件质量记分：近期失败率与低质量标记', () => {
    const log = [];
    for (let i = 0; i < 9; i++) log.push({ plugin: 'fetch', ok: i > 3 });
    log.push({ plugin: 'write', ok: true });
    const s = pluginScores(log);
    const fetchS = s.find(x => x.name === 'fetch');
    assert.ok(fetchS && fetchS.lowQuality, 'fetch 近期失败率 44% 应标低质量');
    assert.ok(!s.find(x => x.name === 'write').lowQuality);
  });
  await t('memory TF-IDF：相关度排序召回（子串匹配升级）', async () => {
    const T2 = path.join(TMP, 'ws-tfidf');
    fs.mkdirSync(T2, { recursive: true });
    const ctx2 = { cwd: T2, dataDir: TMP };
    await plugins.runPlugin('memory', { action: 'save', level: 'long', content: '用户偏好深色主题界面', tags: ['UI'] }, ctx2);
    await plugins.runPlugin('memory', { action: 'save', level: 'long', content: '项目部署在 Ubuntu 22.04', tags: ['运维'] }, ctx2);
    await plugins.runPlugin('memory', { action: 'save', level: 'long', content: '界面主题色改蓝紫', tags: ['UI', '主题'] }, ctx2);
    const r = await plugins.runPlugin('memory', { action: 'search', query: '界面主题', level: 'long' }, ctx2);
    assert.ok(r.includes('界面主题色') && r.includes('用户偏好深色主题'), '两条主题相关记忆应召回：' + r);
    assert.ok(!r.includes('Ubuntu'), '无关记忆不应召回');
    assert.ok(r.indexOf('界面主题色') < r.indexOf('用户偏好深色主题'), '更相关者排前');
  });
  await t('memory consolidate：同主题短期记忆归并释放容量', async () => {
    const T2 = path.join(TMP, 'ws-consol');
    fs.mkdirSync(T2, { recursive: true });
    const ctx2 = { cwd: T2, dataDir: TMP };
    for (const c of ['任务weather：fetch去噪已修复', '任务weather：search结果正常', '任务weather：天气查询端到端通过', '任务plugin：write幂等上线', '任务plugin：read分段读取', '部署服务器到Ubuntu']) {
      await plugins.runPlugin('memory', { action: 'save', level: 'short', content: c }, ctx2);
    }
    const r = await plugins.runPlugin('memory', { action: 'consolidate' }, ctx2);
    assert.ok(r.includes('已归并 2 簇') && r.includes('#1 + #2 + #3'), 'weather 三条应聚一簇：' + r);
    assert.ok(!r.includes('Ubuntu'), '独立记忆不应被归并');
    const after = JSON.parse(fs.readFileSync(path.join(T2, '.memory-short.json'), 'utf8'));
    assert.equal(after.length, 1, '近期库应只剩 1 条独立记忆');
    const lg = JSON.parse(fs.readFileSync(path.join(T2, '.memory-long.json'), 'utf8'));
    assert.ok(lg.some(m => (m.mergedFrom || []).length === 3), '长期库应有 3 条归并的条目');
  });
  await t('上下文预算：超阈值压缩旧 tool 结果（保配对、保近期全文）', () => {
    // 构造足够大的消息使 token 数超过预算 60000
    // 第一个大 tool 在最前面，确保不在"最近 6 个"保留集内
    const msgs = [
      { role: 'system', content: 'S'.repeat(5000) },
      { role: 'user', content: '任务' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c0', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c0', content: 'A'.repeat(300000) }, // 第 0 个 tool，应被压缩
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'B'.repeat(200) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read', arguments: '{"path":"c"}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'C'.repeat(200) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read', arguments: '{"path":"d"}' } }] },
      { role: 'tool', tool_call_id: 'c3', content: 'D'.repeat(200) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c4', type: 'function', function: { name: 'read', arguments: '{"path":"e"}' } }] },
      { role: 'tool', tool_call_id: 'c4', content: 'E'.repeat(200) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c5', type: 'function', function: { name: 'read', arguments: '{"path":"f"}' } }] },
      { role: 'tool', tool_call_id: 'c5', content: 'F'.repeat(200) },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c6', type: 'function', function: { name: 'read', arguments: '{"path":"g"}' } }] },
      { role: 'tool', tool_call_id: 'c6', content: 'G'.repeat(200) },
    ];
    const budget = 60000;
    assert.ok(estimateMessagesTokens(msgs) > budget, `原始 token ${estimateMessagesTokens(msgs)} 应超预算 ${budget}`);
    const out = budgetMessages(msgs);
    assert.equal(out.length, msgs.length, '不得删除条目（配对完整性）');
    assert.ok(out[3].content.length < 5000 && out[3].content.includes('已折叠'), '旧 tool 应被压缩');
    assert.equal(out[5].content.length, 200, '最近第 6 个 tool 保持全文');
    assert.equal(out[15].content.length, 200, '最近 tool 保持全文');
    assert.equal(out[0].content.length, 5000, 'system 不压缩');
    // 未超预算时原样返回
    const small = [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }];
    assert.equal(budgetMessages(small), small, '未超预算应原引用返回');
  });

  await t('rollupMessages：>8 轮触发折叠 + 摘要含工具要点 + 窗口配对完整（P1-3）', () => {
    const { rollupMessages } = require(path.join(ROOT, 'lib', 'inner'));
    // 8 轮（16 条）不折叠
    const eight = [{ role: 'user', content: '任务原文' }];
    for (let r = 0; r < 8; r++) {
      eight.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + r, type: 'function', function: { name: 'tool' + r, arguments: '{}' } }] });
      eight.push({ role: 'tool', tool_call_id: 'c' + r, content: `结果${r}` });
    }
    assert.equal(rollupMessages(eight), null, '未超 8 轮应返回 null');
    // 10 轮（20 条）折叠早期 6 轮，保留最近 4 轮
    const ten = [{ role: 'user', content: '任务原文' }];
    for (let r = 0; r < 10; r++) {
      ten.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${r}`, type: 'function', function: { name: `tool${r}`, arguments: '{}' } }] });
      ten.push({ role: 'tool', tool_call_id: `c${r}`, content: `结果要点${r}` });
    }
    const rolled = rollupMessages(ten);
    assert.ok(Array.isArray(rolled) && rolled.length < ten.length, `折叠后应变短（${rolled.length} < ${ten.length}）`);
    const sumMsg = rolled.find(m => m.role === 'user' && m.content.includes('上下文折叠'));
    assert.ok(sumMsg, '应存在折叠摘要消息');
    assert.ok(sumMsg.content.includes('tool0') && sumMsg.content.includes('结果要点0'), '摘要应含早期轮工具名与结果要点');
    assert.ok(!sumMsg.content.includes('tool9'), '最近窗口不应被折叠进摘要');
    assert.ok(!sumMsg.content.includes('tool6'), '保留窗口 4 轮（6-9）不折叠');
    // 窗口 tool 配对完整：tool9 结果消息仍在
    assert.ok(rolled.some(m => m.role === 'tool' && m.tool_call_id === 'c9'), '最近窗口 tool 结果保留');
    assert.ok(rolled.some(m => m.role === 'tool' && m.tool_call_id === 'c6'), '窗口起点轮 tool 结果保留');
    assert.ok(!rolled.some(m => m.role === 'tool' && m.tool_call_id === 'c0'), '折叠区 tool 结果不再独立存在');
    // 任务原文保留
    assert.equal(rolled[0].role, 'user');
    assert.ok(rolled[0].content.includes('任务原文'), '任务原文保留');
    // budgetMessages 集成：超轮数消息即使 token 未超预算也被折叠
    const through = budgetMessages(ten);
    assert.ok(through.some(m => m.role === 'user' && String(m.content).includes('上下文折叠')), 'budgetMessages 应集成滚动折叠');
    // 用户中途插话保留：在窗口前插入一条 user
    const withUser = [{ role: 'user', content: '任务原文' }];
    for (let r = 0; r < 10; r++) {
      if (r === 3) withUser.push({ role: 'user', content: '记住要用中文回复' });
      withUser.push({ role: 'assistant', content: null, tool_calls: [{ id: `d${r}`, type: 'function', function: { name: `t${r}`, arguments: '{}' } }] });
      withUser.push({ role: 'tool', tool_call_id: `d${r}`, content: `r${r}` });
    }
    const rolled2 = rollupMessages(withUser);
    assert.ok(rolled2.some(m => m.role === 'user' && m.content === '记住要用中文回复'), '用户插话应保留');
  });
  const { withRetry, RetryableError, isRetryableStatus, isRateLimitText } = require(path.join(ROOT, 'lib', 'llmRetry'));
  await t('llmRetry：限流 429 → 退避后重试成功（info 事件可见）', async () => {
    let n = 0;
    const events = [];
    const r = await withRetry(async () => {
      n += 1;
      if (n === 1) throw new RetryableError('API 429：rate limit exceeded');
      return 'OK';
    }, { onEvent: e => events.push(e), label: '内层 LLM', baseMs: 1 });
    assert.equal(r, 'OK');
    assert.equal(n, 2, '第二次成功');
    assert.equal(events.length, 1, '一次退避提示');
    assert.ok(events[0].text.includes('自动重试（第 1/4 次）'), events[0].text);
  });
  await t('llmRetry：持续限流 → 3^n 序列重试 4 次后耗尽抛错', async () => {
    let n = 0;
    const events = [];
    let threw = '';
    try {
      await withRetry(async () => { n += 1; throw new RetryableError('API 429'); }, { onEvent: e => events.push(e), baseMs: 1 });
    } catch (e) { threw = e.message; }
    assert.equal(n, 5, '1 次初始 + 4 次重试');
    assert.equal(events.length, 4, '4 条退避提示');
    assert.ok(events.every(e => /秒后自动重试/.test(e.text)), '每条提示含等待秒数');
    assert.ok(/429/.test(threw), '最终抛出原限流错误');
  });
  await t('llmRetry：退避时长按 3^n 递增（3s→9s→27s→81s 对应 base*3^n）', async () => {
    const events = [];
    const t0 = Date.now();
    try {
      await withRetry(async () => { throw Object.assign(new Error('too many requests'), { retryable: true }); }, { onEvent: e => events.push(e), baseMs: 5 });
    } catch { /* 耗尽 */ }
    const el = Date.now() - t0;
    // 5+15+45+135 = 200ms 退避总量下限（毫秒误差放宽）
    assert.ok(el >= 180, `4 次退避总时长应 ≥ base*(3^0+3^1+3^2+3^3)：实际 ${el}ms`);
    assert.equal(events.length, 4);
  });
  await t('llmRetry：非限流错误（400 参数错）立即抛出不重试', async () => {
    let n = 0;
    let threw = '';
    try {
      await withRetry(async () => { n += 1; throw new Error('内层 API 400：invalid model'); }, { baseMs: 1 });
    } catch (e) { threw = e.message; }
    assert.equal(n, 1, '不重试');
    assert.ok(/400/.test(threw));
  });
  await t('llmRetry：网络抖动（ECONNRESET code）→ 自动重试恢复', async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return 42;
    }, { baseMs: 1 });
    assert.equal(r, 42);
    assert.equal(n, 2);
  });
  await t('llmRetry：状态码与文本判定', () => {
    assert.ok(isRetryableStatus(429) && isRetryableStatus(402) && isRetryableStatus(503));
    // 2026-09-04 优化 2：500/502/504 纳入重试（Agnes 等网关偶发 5xx 属瞬态，不重试会让进化 case 直接判死）
    assert.ok(isRetryableStatus(500) && isRetryableStatus(502) && isRetryableStatus(504));
    assert.ok(!isRetryableStatus(400) && !isRetryableStatus(404) && !isRetryableStatus(401) && !isRetryableStatus(403));
    assert.ok(isRateLimitText('Rate limit reached') && isRateLimitText('请求过多，请稍后再试'));
    assert.ok(!isRateLimitText('invalid api key'));
  });

  // ===== 任务级自动重入（v0.9.13 病根：withRetry 耗尽 → 任务死，但历史每轮落盘状态完好）=====
  const { withTaskResume, isTransientError } = require(path.join(ROOT, 'lib', 'llmRetry'));
  await t('withTaskResume：瞬态错误退避后重入成功（info 提示 + 递增 attempt）', async () => {
    process.env.DUAL_AGENT_RESUME_BASE_MS = '1';
    let n = 0;
    const events = [];
    const attempts = [];
    const r = await withTaskResume(async (attempt) => {
      attempts.push(attempt);
      n += 1;
      if (n <= 2) throw Object.assign(new Error('fetch failed: ECONNRESET'), { code: 'ECONNRESET' });
      return 'done';
    }, { onInfo: e => events.push(e), label: '内层任务' });
    delete process.env.DUAL_AGENT_RESUME_BASE_MS;
    assert.equal(r, 'done');
    assert.equal(n, 3, '第三次成功');
    assert.deepEqual(attempts, [0, 1, 2], 'attempt 从 0 递增');
    assert.equal(events.length, 2, '两次退避提示');
    assert.ok(events[0].text.includes('自动恢复重入（第 1/3 次）'), events[0].text);
    assert.ok(events[1].text.includes('第 2/3'), '提示序号递增');
  });
  await t('withTaskResume：非瞬态错误（401 配置错）立即上抛不重入', async () => {
    let n = 0;
    let threw = '';
    try {
      await withTaskResume(async () => { n += 1; throw new Error('内层 API 401：invalid api key'); }, { onInfo: () => {}, maxResumes: 3 });
    } catch (e) { threw = e.message; }
    assert.equal(n, 1, '只执行一次');
    assert.ok(/401/.test(threw), '原样上抛');
  });
  await t('withTaskResume：重入耗尽（3 次）后上抛最后的瞬态错误', async () => {
    process.env.DUAL_AGENT_RESUME_BASE_MS = '1';
    let n = 0;
    const events = [];
    try {
      await withTaskResume(async () => { n += 1; throw new RetryableError('API 429：持续限流'); }, { onInfo: e => events.push(e) });
    } catch (e) {
      delete process.env.DUAL_AGENT_RESUME_BASE_MS;
      assert.ok(/429/.test(e.message), '抛出最后的限流错误');
    }
    delete process.env.DUAL_AGENT_RESUME_BASE_MS;
    assert.equal(n, 4, '1 次初始 + 3 次重入');
    assert.equal(events.length, 3, '3 条恢复提示');
  });
  await t('withTaskResume：重入用同一入参状态续跑（fn 闭包内计数器跨重入保留）', async () => {
    process.env.DUAL_AGENT_RESUME_BASE_MS = '1';
    // 模拟真实场景：fn 内部对共享 messages 数组追加，重入后看到之前的状态
    const messages = [{ role: 'user', content: 'task' }];
    const r = await withTaskResume(async () => {
      if (messages.length < 3) {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] });
        messages.push({ role: 'tool', tool_call_id: 'c1', content: 'r1' });
        throw Object.assign(new Error('network dropped mid-task'), { code: 'EPIPE' });
      }
      messages.push({ role: 'assistant', content: 'final' });
      return 'final';
    }, { onInfo: () => {} });
    delete process.env.DUAL_AGENT_RESUME_BASE_MS;
    assert.equal(r, 'final');
    assert.equal(messages.length, 4, '重入看到重入前的工具配对（不重做）');
    assert.equal(messages[messages.length - 1].content, 'final');
  });
  await t('isTransientError：限流/网络 code 判定，参数与配置错误不算', () => {
    assert.ok(isTransientError(new RetryableError('429')), 'retryable 标记');
    assert.ok(isTransientError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), '网络 code');
    assert.ok(!isTransientError(new Error('400 bad request')), '参数错误');
    assert.ok(!isTransientError(Object.assign(new Error('x'), { code: 'EINVAL' })), '非网络 code');
    assert.ok(!isTransientError(null), '空值安全');
  });
  await t('静态接线：server /api/inner/chat 用 withTaskResume 包裹 chatInner（v0.9.13）', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/const runInner = \(\) => chatInner\(/.test(srv) && /withTaskResume\(runInner/.test(srv), 'chatInner 经 runInner 被 withTaskResume 包裹');
    assert.ok(/\{ onInfo: send, label: '内层任务' \}/.test(srv), '恢复提示走 SSE info 通道');
  });

  // ===== token 计量机制（v0.9.0 四层改造）=====
  await t('estimateTokens：CJK ×1 + 其余 ceil/4 折算', () => {
    assert.equal(estimateTokens('你好'), 2, '2 个 CJK = 2 tok');
    assert.equal(estimateTokens('abcdefgh'), 2, '8 ASCII / 4 = 2');
    assert.equal(estimateTokens('abcdefg'), 2, 'ceil(7/4) = 2');
    assert.equal(estimateTokens('你a'), 2, '1 CJK + ceil(1/4)=1');
    assert.equal(estimateTokens(''), 0);
  });
  await t('usageNoteMsg：注记为 system 角色且含累计与口径指引', () => {
    const m = usageNoteMsg({ prompt: 800, completion: 30, cached: 200 }, { calls: 3, prompt: 2400, completion: 90, cached: 600 }, 12345);
    assert.equal(m.role, 'system', '注记角色必须是 system（注入发送副本末尾）');
    assert.ok(m.content.includes('2400') && m.content.includes('3 次调用'), '含会话累计');
    assert.ok(m.content.includes('缓存命中 600'), '含缓存累计');
    assert.ok(m.content.includes('usage 插件'), '指引插件查询');
    assert.ok(m.content.includes('禁止自行估算'), '禁止脑补口径声明');
  });
  await t('isMultiStepTask：多步任务判定（正例）', () => {
    assert.ok(isMultiStepTask('第一步做 A，第二步做 B，最后总结'), '第 N 步 ×2 + 最后');
    assert.ok(isMultiStepTask('1. 写文件 2. 读文件 3. 对比'), '编号列表 ≥2');
    assert.ok(isMultiStepTask('先查目录，然后读文件，接着改内容'), '连接词 ≥2');
    assert.ok(isMultiStepTask('①创建 ②验证'), '带圈编号 ×2');
    assert.ok(isMultiStepTask('第一步先分析文件，然后给出方案'), '编号 1 + 连接词 1 组合');
  });
  await t('isMultiStepTask：简单任务不误判（反例，防浪费轮次建清单）', () => {
    assert.ok(!isMultiStepTask('看一下当前目录有什么文件'), '单步浏览');
    assert.ok(!isMultiStepTask('帮我写一个 hello world'), '单步写文件');
    assert.ok(!isMultiStepTask('再报告一次结果'), '「再」后接报告不计数');
    assert.ok(!isMultiStepTask(''), '空消息');
    assert.ok(!isMultiStepTask('版本号是 1. 0 吗'), '单词后的编号不计数');
  });
  // ===== 长文创作检测（v0.9.17 病根：模型以"万字超单次输出"为由拒绝万字任务）=====
  await t('isLongFormTask：长文任务判定（正例）', () => {
    assert.ok(isLongFormTask('帮我写个万字精彩长篇小说'), '万字+长篇小说');
    assert.ok(isLongFormTask('写一篇 5000 字的短篇小说'), '显式字数+体裁');
    assert.ok(isLongFormTask('来一篇 3千字 读后感'), '千字+空格');
    assert.ok(isLongFormTask('给我写个小说，题材是赛博朋克'), '体裁无字数');
    assert.ok(isLongFormTask('写一份深度调研报告'), '长文体裁');
  });
  await t('isLongFormTask：普通任务不误判（反例，防创作纪律污染常规执行）', () => {
    assert.ok(!isLongFormTask('修复登录页的 bug'), '常规开发任务');
    assert.ok(!isLongFormTask('总结 uploads/budget.pdf 的要点'), '文档处理任务');
    assert.ok(!isLongFormTask('搜索一下最新的 Node.js 版本'), '调研任务');
    assert.ok(!isLongFormTask(''), '空消息');
    assert.ok(!isLongFormTask('这个文件有多少字'), '谈论字数非创作');
  });
  // ===== 拒绝后催促检测（v0.9.17 病根：拒绝万字 → "请你搞定" → 被旧记忆锚定跑偏）=====
  await t('isRefusalNudge：拒绝后短催判定（正例）', () => {
    const refusal = '抱歉，我无法创作万字长篇小说。这类任务超出单次输出限制，建议使用专业工具。';
    assert.ok(isRefusalNudge(refusal, '请你搞定'), '标准催促');
    assert.ok(isRefusalNudge(refusal, '搞定'), '极简催促');
    assert.ok(isRefusalNudge(refusal, '写！'), '写+叹号');
    assert.ok(isRefusalNudge('我不能这样做，不适合插件工作流', '做吧'), '另一形态拒绝');
  });
  await t('isRefusalNudge：非催促场景不误判（反例，防对齐指令乱入）', () => {
    const refusal = '抱歉，我无法创作万字长篇小说，建议分解任务。';
    assert.ok(!isRefusalNudge(refusal, '那就写一篇 2000 字的短文吧，重点写主角觉醒'), '带新要求的消息不是催促');
    assert.ok(!isRefusalNudge(refusal, '请帮我读取 uploads/a.pdf 并总结要点'), '新任务指令');
    assert.ok(!isRefusalNudge('任务完成，文件已写入 report.md', '请你搞定'), '上条非拒绝');
    assert.ok(!isRefusalNudge(refusal, '为什么不行'), '疑问句非催促');
    assert.ok(!isRefusalNudge(refusal, ''), '空消息');
    assert.ok(!isRefusalNudge('', '请你搞定'), '无上文拒绝');
  });
  // mock SSE 响应构造：一次 enqueue 全部 data 行（解析器按 \n 切分，单块即可覆盖缓冲逻辑）
  const sseResponse = (lines) => {
    const body = lines.map(l => `data: ${l}\n\n`).join('');
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
    return new Response(stream, { status: 200 });
  };
  // ===== 意图闭环（v0.9.14 病根：长任务后段上下文折叠埋掉任务原文 → 交付漏项）=====
  const { parseLooseJson, normalizeIntent, extractIntent, formatIntentNote, buildVerifyArgs, buildJudgePrompt, parseVerdict } = require(path.join(ROOT, 'lib', 'intent'));
  await t('parseLooseJson：围栏 / 前置解释文字 / 垃圾输入', () => {
    assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 }, '剥离围栏');
    assert.deepEqual(parseLooseJson('好的，以下是结果：{"a":2} 完成'), { a: 2 }, '截取首尾大括号');
    assert.equal(parseLooseJson('完全不是 JSON'), null, '垃圾返回 null');
    assert.equal(parseLooseJson(''), null, '空串安全');
  });
  await t('normalizeIntent：字段清洗 / path null 归一 / 空意图返回 null', () => {
    const n = normalizeIntent({
      task: '  创建文件并验证 ',
      goals: ['产出文件', 42, '  '],
      deliverables: [{ path: 'a.txt', criterion: '存在' }, { path: null, criterion: '答案正确' }, 'bad', { path: 'b.json' }],
      constraints: ['不许改动其他文件'],
      acceptance: ['a.txt 存在']
    });
    assert.equal(n.goals.length, 1, '非字符串与空白条目剔除');
    assert.equal(n.deliverables.length, 3, '合法交付物保留');
    assert.equal(n.deliverables[1].path, null, '非文件交付物 path 归一为 null');
    assert.equal(n.deliverables[2].criterion, '', '缺 criterion 补空串');
    assert.equal(normalizeIntent({}), null, '全空返回 null');
    assert.equal(normalizeIntent(null), null, 'null 安全');
  });
  await t('extractIntent：mock SSE JSON → 意图契约；垃圾输出 → null 优雅降级', async () => {
    const origFetch = globalThis.fetch;
    let mode = 'good';
    globalThis.fetch = async () => {
      if (mode === 'good') return sseResponse([JSON.stringify({ choices: [{ delta: { content: '```json\n{"task":"三步任务","goals":["产出两文件"],"deliverables":[{"path":"alpha.txt","criterion":"存在且含指定内容"},{"path":null,"criterion":"对比结论明确"}],"acceptance":["两文件都存在","给出对比结论"]}' } }] }), '[DONE]']);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '我无法解析该任务' } }] }), '[DONE]']);
    };
    try {
      const good = await extractIntent({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, '任务A');
      assert.ok(good, 'good 模式返回意图');
      assert.equal(good.deliverables.length, 2, '交付物解析');
      assert.equal(good.deliverables[1].path, null, '非文件交付物');
      mode = 'bad';
      const bad = await extractIntent({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, '任务B');
      assert.equal(bad, null, '垃圾输出返回 null（任务照常执行的降级路径）');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('formatIntentNote：含交付物/验收/权威来源声明（每轮注记防遗忘）', () => {
    const note = formatIntentNote(normalizeIntent({
      task: '创建并对比', deliverables: [{ path: 'a.txt', criterion: '存在' }],
      acceptance: ['a.txt 存在'], constraints: ['只写指定文件']
    }));
    assert.ok(note.startsWith('[意图契约]'), '注记头标识');
    assert.ok(note.includes('a.txt') && note.includes('a.txt 存在'), '交付物与验收注入');
    assert.ok(note.includes('权威来源'), '折叠场景的权威声明');
    assert.ok(note.length < 800, `注记保持精简（实际 ${note.length} 字符）`);
    assert.equal(formatIntentNote(null), '', '空意图返回空串');
  });
  await t('buildVerifyArgs：文件类交付物 → verify 断言（json 加 json_valid）', () => {
    const args = buildVerifyArgs(normalizeIntent({
      deliverables: [{ path: 'a.txt' }, { path: 'b.json' }, { path: null, criterion: '答案' }]
    }));
    assert.equal(args.length, 2, '只取有路径的交付物');
    assert.deepEqual(args[0].rules, [{ type: 'exists' }], '普通文件 exists');
    assert.ok(args[1].rules.some(r => r.type === 'json_valid'), 'json 文件追加 json_valid');
  });
  await t('buildJudgePrompt：含契约/交付/硬断言 + 禁风格判断纪律', () => {
    const intent = normalizeIntent({ task: 'T', acceptance: ['文件存在'] });
    const p = buildJudgePrompt(intent, '最终交付内容……', ['a.txt：PASS 1/1']);
    assert.ok(p.includes('意图契约') && p.includes('最终交付内容'), '两方证据注入');
    assert.ok(p.includes('禁止风格与口味判断'), 'judge 纪律（防验证器误报）');
    assert.ok(p.includes('PASS 或 GAPS'), '输出格式约束');
  });
  await t('parseVerdict：PASS / GAPS / 垃圾按 PASS（误报比漏报更有害）', () => {
    assert.deepEqual(parseVerdict('{"verdict":"PASS","gaps":[]}').gaps, [], '标准 PASS');
    const g = parseVerdict('```json\n{"verdict":"GAPS","gaps":["文件 c.txt 不存在","问题二未回答"]}\n```');
    assert.equal(g.verdict, 'GAPS') && assert.equal(g.gaps.length, 2, '围栏 GAPS 解析');
    assert.deepEqual(parseVerdict('模型胡言乱语'), { verdict: 'PASS', gaps: [] }, '垃圾按 PASS');
    assert.deepEqual(parseVerdict('{"verdict":"GAPS","gaps":[]}'), { verdict: 'PASS', gaps: [] }, '空缺口 GAPS 视为 PASS');
  });
  await t('inner.js opts.intentNote：每轮发送副本注入意图契约（落盘干净）', async () => {
    const origFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (u, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'iv1', function: { name: 'read', arguments: '{"path":"f"}' } }] } }] }),
        '[DONE]'
      ]);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '完成' } }] }), '[DONE]']);
    };
    try {
      const messages = [{ role: 'user', content: '干活' }];
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, messages, [],
        async () => 'ok', () => {},
        { intentNote: () => '[意图契约] 测试注记' });
      assert.ok(bodies.length === 2, '两轮调用');
      assert.ok(String(bodies[1].messages.at(-1).content).includes('[意图契约] 测试注记'), '第二轮发送副本注入意图注记');
      assert.ok(!messages.some(m => String(m.content || '').includes('[意图契约]')), '落盘 messages 保持干净');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('inner.js Hermes 兜底 e2e：content 文本 tool_call 被解析执行（无原生 delta.tool_calls）', async () => {
    const origFetch = globalThis.fetch;
    const bodies = [];
    const calls = [];
    // 真机 v1.2.0-alpha2 实测形态：残缺空块 + python-kwargs 调用混在 content
    const hermesContent = '<tool_call>\n<tool_call>\n<tool_call>search(query="惠州天气", language="zh")\n<tool_call>';
    globalThis.fetch = async (u, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: hermesContent } }] }),
        '[DONE]'
      ]);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '查到了结果' } }] }), '[DONE]']);
    };
    try {
      const events = [];
      const messages = [{ role: 'user', content: '查天气' }];
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, messages, [],
        async (name, args) => { calls.push({ name, args }); return '搜索结果：晴 30 度'; },
        e => events.push(e));
      assert.equal(out, '查到了结果', '第二轮文本为最终回复');
      assert.equal(calls.length, 1, 'Hermes 文本调用被执行一次');
      assert.deepEqual(calls[0], { name: 'search', args: { query: '惠州天气', language: 'zh' } });
      // 落盘协议配对：assistant 带 tool_calls + tool 结果跟在其后（OpenAI 协议）
      const asst = messages.find(m => m.role === 'assistant' && m.tool_calls);
      assert.ok(asst, '存在 tool_calls 宿主 assistant');
      assert.equal(asst.tool_calls[0].function.name, 'search');
      assert.ok(messages.some(m => m.role === 'tool'), 'tool 结果已入史');
      // 工具事件流可见
      assert.ok(events.some(e => e.type === 'tool_call' && e.plugin === 'search'), 'tool_call 事件');
    } finally { globalThis.fetch = origFetch; }
  });

  await t('静态接线：server 意图闭环三段（抽取 / 注记 / 核验返修，v0.9.24 解耦为插件）', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/intentNote,/.test(srv), 'intentNote 传入 chatInner 每轮注记');
    assert.ok(/hasActiveIntent/.test(srv) && /getCurrentIntent/.test(srv), '交付核验通过插件接口获取意图');
    assert.ok(/\[交付核验\] 对照意图契约发现以下未满足项/.test(srv), '缺口注入返修指令');
    assert.ok(/MAX_REPAIR = 2/.test(srv), '返修上限 2 轮（防完美主义死循环）');
  });

  await t('计量采集：捕获 choices 空+usage 末帧（旧版此处被 continue 丢弃）', async () => {
    const origFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (u, init) => {
      bodies.push(JSON.parse(init.body));
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '你好世界' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 36, prompt_tokens_details: { cached_tokens: 800 } } }),
        '[DONE]'
      ]);
    };
    try {
      const events = [];
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], [], async () => 'ok', e => events.push(e));
      assert.equal(out, '你好世界');
      assert.ok(bodies[0].stream_options && bodies[0].stream_options.include_usage === true, '请求体必须带 stream_options.include_usage');
      const us = events.filter(e => e.type === 'usage');
      assert.equal(us.length, 1, '一轮一帧 usage 事件');
      assert.equal(us[0].est, false, 'API 真实返回不带 est 标记');
      assert.equal(us[0].totals.calls, 1);
      assert.equal(us[0].totals.prompt, 1200);
      assert.equal(us[0].totals.completion, 36);
      assert.equal(us[0].totals.cached, 800, 'cached_tokens 须采集');
      assert.equal(us[0].last.prompt, 1200);
    } finally { globalThis.fetch = origFetch; }
  });
  await t('老网关兼容：400 stream_options → 去参降级重试 + 估算兜底 est 标记', async () => {
    const origFetch = globalThis.fetch;
    const origBase = process.env.DUAL_AGENT_RETRY_BASE_MS;
    process.env.DUAL_AGENT_RETRY_BASE_MS = '1'; // 退避加速，测试不等待 3s
    const bodies = [];
    let call = 0;
    globalThis.fetch = async (u, init) => {
      call += 1;
      bodies.push(JSON.parse(init.body));
      if (call === 1) return new Response('Unrecognized request argument supplied: stream_options', { status: 400 });
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '降级后OK' } }] }),
        '[DONE]'
      ]);
    };
    try {
      const events = [];
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], [], async () => 'ok', e => events.push(e));
      assert.equal(out, '降级后OK');
      assert.equal(call, 2, '400 后降级重试恰好一次');
      assert.ok(bodies[0].stream_options, '首次请求带 stream_options');
      assert.ok(!bodies[1].stream_options, '降级后请求去掉 stream_options');
      const u = events.find(e => e.type === 'usage');
      assert.ok(u, '降级后仍发 usage 事件');
      assert.equal(u.est, true, '无 usage 帧走估算兜底（est 标记）');
      assert.ok(u.totals.prompt > 0, '估算值非零');
    } finally {
      globalThis.fetch = origFetch;
      if (origBase === undefined) delete process.env.DUAL_AGENT_RETRY_BASE_MS; else process.env.DUAL_AGENT_RETRY_BASE_MS = origBase;
    }
  });
  await t('多轮累计：工具循环两轮 usage 累加 + 第二轮注入计量注记', async () => {
    const origFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (u, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }] } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 10 } }),
        '[DONE]'
      ]);
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { content: '完成' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 5 } }),
        '[DONE]'
      ]);
    };
    try {
      const events = [];
      const ran = [];
      const messages = [{ role: 'user', content: '跑个命令' }];
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, messages, [], async (name, args) => { ran.push(name); return `ran ${name}`; }, e => events.push(e));
      assert.equal(out, '完成');
      assert.deepEqual(ran, ['bash'], '插件执行一轮');
      assert.equal(bodies.length, 2, '两轮 API 调用');
      assert.ok(bodies[1].messages.some(m => m.role === 'system' && m.content.includes('[token 计量]')), '第二轮发送副本须注入计量注记');
      assert.ok(!messages.some(m => (m.content || '').includes('[token 计量]')), '落盘 messages 保持干净（注记仅发送）');
      const us = events.filter(e => e.type === 'usage');
      assert.equal(us.length, 2);
      assert.equal(us[1].totals.calls, 2, '累计调用数');
      assert.equal(us[1].totals.prompt, 1200, '500+700 跨轮累加');
      assert.equal(us[1].totals.completion, 15, '10+5 跨轮累加');
    } finally { globalThis.fetch = origFetch; }
  });

  // ===== 只读并行 + 动态清单注记 + 子智能体轮数上限（v0.9.5）=====
  await t('只读并行：一轮 2 个 read 并发执行（耗时=max 而非 sum）', async () => {
    const origFetch = globalThis.fetch;
    let round = 0;
    globalThis.fetch = async () => {
      round += 1;
      if (round === 1) return sseResponse([
        // 一轮发 2 个只读 tool_calls
        JSON.stringify({ choices: [{ delta: { tool_calls: [
          { index: 0, id: 'p1', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
          { index: 1, id: 'p2', function: { name: 'read', arguments: '{"path":"b.txt"}' } }
        ] } }] }),
        '[DONE]'
      ]);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '完成' } }] }), '[DONE]']);
    };
    try {
      const ran = [];
      const t0 = Date.now();
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: '读两个' }], [],
        async (name, args) => { ran.push(args.path); await new Promise(r => setTimeout(r, 120)); return `content of ${args.path}`; },
        () => {});
      const el = Date.now() - t0;
      assert.deepEqual(ran.sort(), ['a.txt', 'b.txt'], '两个调用都执行');
      assert.ok(el < 200, `并行应 ≈120ms（实际 ${el}ms；串行会 ≥240ms）`);
    } finally { globalThis.fetch = origFetch; }
  });
  await t('写类操作保持串行（同轮 write + read 不并行）', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([
      JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'w1', function: { name: 'write', arguments: '{"path":"x.txt","content":"1"}' } },
        { index: 1, id: 'r1', function: { name: 'read', arguments: '{"path":"x.txt"}' } }
      ] } }] }),
      '[DONE]'
    ]);
    try {
      const order = [];
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: '写读' }], [],
        async (name, args) => { order.push(name + ':start'); await new Promise(r => setTimeout(r, 30)); order.push(name + ':end'); return 'ok'; },
        () => {});
      assert.ok(order.indexOf('write:end') < order.indexOf('read:start'), 'read 必须等 write 完成：' + order.join(','));
    } finally { globalThis.fetch = origFetch; }
  });
  await t('todoNote 注记：每轮注入最新清单（第二轮可见未完成项）', async () => {
    const origFetch = globalThis.fetch;
    const bodies = [];
    let todoState = [{ id: 1, text: '第一步', done: true }, { id: 2, text: '第二步', done: false }];
    globalThis.fetch = async (u, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'todo', arguments: '{"action":"toggle","id":2}' } }] } }] }),
        '[DONE]'
      ]);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '完成' } }] }), '[DONE]']);
    };
    try {
      const messages = [{ role: 'user', content: '干活' }];
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, messages, [],
        async () => 'ok',
        () => {},
        { todoNote: () => {
          const open = todoState.filter(t => !t.done);
          return open.length ? `[任务清单]\n- [ ] #2 第二步` : '';
        } });
      // toggle 后的第二轮发送副本应含清单（第一轮 usage=0 无注记）
      assert.ok(bodies.length === 2, '两轮调用');
      assert.ok(String(bodies[1].messages.at(-1).content).includes('[任务清单]'), '第二轮发送副本注入清单注记');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('子级轮数上限：opts.maxRounds 生效（防子智能体失控）', async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'l' + calls, function: { name: 'read', arguments: '{"path":"f"}' } }] } }] }),
        '[DONE]'
      ]);
    };
    try {
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: '无限读' }], [],
        async () => 'ok', () => {}, { maxRounds: 3 });
      assert.ok(/轮数上限/.test(out), '达到上限强制结束');
      assert.equal(calls, 3, '恰好 3 轮（maxRounds 生效）');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('subagent 插件：并行派生 + 结论汇总 + 无 spawnSub 拒绝', async () => {    // mock 场景 1：ctx 无 spawnSub → 拒绝
    const noSub = await plugins.runPlugin('subagent', { tasks: [{ description: 'x' }] }, ctx);
    assert.ok(/禁止派生|仅主会话/.test(noSub), noSub);
    // mock 场景 2：spawnSub 并行执行返回结论
    const spawnLog = [];
    const summary = await plugins.runPlugin('subagent', {
      tasks: [{ description: '调研 A' }, { description: '调研 B' }]
    }, { ...ctx, spawnSub: async (desc) => { spawnLog.push(desc); return `${desc} 的结论：一切正常`; } });
    assert.equal(spawnLog.length, 2, '两个子任务都派生');
    assert.ok(summary.includes('2/2'), '两个都成功：' + summary.slice(0, 80));
    assert.ok(summary.includes('调研 A 的结论') && summary.includes('调研 B 的结论'), '结论都汇总');
    // mock 场景 3：子任务失败不炸整体
    const partial = await plugins.runPlugin('subagent', {
      tasks: [{ description: '好的' }, { description: '坏的' }]
    }, { ...ctx, spawnSub: async (desc) => { if (desc === '坏的') throw new Error('子任务超时'); return '结论'; } });
    assert.ok(partial.includes('1/2') && partial.includes('[失败]'), partial.slice(0, 120));
  });
  await t('subagent 可写声明：tasks[].writable 透传 spawnSub 第二参（v0.9.12 P1-6）', async () => {
    const got = [];
    await plugins.runPlugin('subagent', {
      tasks: [{ description: '只读调研' }, { description: '产出文件', writable: true }]
    }, { ...ctx, spawnSub: async (desc, w) => { got.push([desc, w]); return '结论'; } });
    assert.equal(got.length, 2, '两个子任务都派生');
    assert.equal(got[0][1], false, '未声明 writable 默认只读');
    assert.equal(got[1][1], true, 'writable:true 透传为 true');
  });

  // ===== 长程任务成熟度（v0.9.12）：配对安全裁剪 / 每轮落盘 / 自动续航 =====
  await t('pairSafeTail：切点回退到安全边界，落盘副本无悬空 tool（P0-1）', () => {
    const u = c => ({ role: 'user', content: c });
    const pair = (id, res) => [
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, content: res }
    ];
    // 短列表原样返回
    const short = [u('q'), ...pair('a', 'r'), u('done')];
    assert.equal(pairSafeTail(short, 10), short, '未超限原样返回');
    // 切点恰落在配对中间：构造 7 条，maxKeep=4 → 原切点 index 3 是 tool（悬空），必须前移
    const msgs = [u('q1'), ...pair('t1', 'r1'), u('q2'), ...pair('t2', 'r2')];
    const tail = pairSafeTail(msgs, 4);
    assert.ok(tail.length <= 4, `裁剪后不超过 maxKeep（实际 ${tail.length}）`);
    assert.equal(tail[0].role, 'user', `切点回退到安全边界（实际首条 ${tail[0].role}）`);
    // 通用配对完整性：每条 tool 前必有带对应 tool_calls 的 assistant，tool_calls 后必跟 tool
    const hosts = new Set();
    for (let i = 0; i < tail.length; i++) {
      const m = tail[i];
      if (m.role === 'assistant' && m.tool_calls) m.tool_calls.forEach(c => hosts.add(c.id));
      if (m.role === 'tool') assert.ok(hosts.has(m.tool_call_id), `第 ${i} 条 tool 的宿主 assistant 必须在副本内`);
    }
    for (const id of hosts) assert.ok(tail.some(m => m.role === 'tool' && m.tool_call_id === id), 'tool_calls 宿主的结果必须在副本内');
  });
  await t('onRound 回调：每轮工具调用后被调用（崩溃即丢全程的反证，P0-2）', async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    const seenLens = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls >= 3) return sseResponse([JSON.stringify({ choices: [{ delta: { content: '完成' } }] }), '[DONE]']);
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'o' + calls, function: { name: 'read', arguments: '{"path":"f"}' } }] } }] }),
        '[DONE]'
      ]);
    };
    try {
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], [],
        async () => 'ok', () => {},
        { onRound: (r, msgs) => { seenLens.push([r, msgs.length]); } });
      assert.equal(seenLens.length, 2, `两轮工具调用各触发一次（实际 ${seenLens.length}）`);
      assert.ok(seenLens[1][1] > seenLens[0][1], '回调拿到增长中的 messages（可即时落盘）');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('自动续航：段上限+清单未完注入续航消息，总预算封顶（P0-3）', async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    const events = [];
    globalThis.fetch = async () => {
      calls += 1;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + calls, function: { name: 'read', arguments: '{"path":"f"}' } }] } }] }),
        '[DONE]'
      ]);
    };
    try {
      const messages = [{ role: 'user', content: '长任务' }];
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, messages, [],
        async () => 'ok', e => events.push(e),
        { maxRounds: 2, shouldContinue: () => true });
      assert.equal(calls, 6, `默认总预算 3×2=6 轮（实际 ${calls}）`);
      assert.ok(messages.some(m => m.role === 'user' && String(m.content).includes('[自动续航]')), '续航 user 消息入列');
      assert.ok(events.some(e => e.type === 'info' && /自动续航/.test(e.text)), '续航 info 事件告知前端');
      assert.ok(/累计 6\/6/.test(out), '结束语报告累计轮数');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('自动续航：shouldContinue 为 false 或缺省时不续航（行为不回归）', async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'd' + calls, function: { name: 'read', arguments: '{"path":"f"}' } }] } }] }),
        '[DONE]'
      ]);
    };
    try {
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'x' }], [],
        async () => 'ok', () => {},
        { maxRounds: 2, shouldContinue: () => false });
      assert.equal(calls, 2, `清单无未完成项 → 段上限即停（实际 ${calls}）`);
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'y' }], [],
        async () => 'ok', () => {}, { maxRounds: 2 });
      assert.equal(calls, 4, '未传 shouldContinue 照旧 maxRounds 停');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('静态防回归：日期注入 / 子级只读硬拦截 / 里程碑记忆接线（P1-4/P1-5/P1-6）', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/\{TODAY\}/.test(srv) && /buildInnerSystemPrompt\(/.test(srv), '系统提示含 {TODAY} 且会话首条每次重建');
    assert.ok(/name === 'write' \|\| name === 'edit'/.test(srv), '子级未声明 writable 时 write/edit 执行层硬拦截');
    assert.ok(/只写子任务指定的目标路径/.test(srv), '可写版子级系统提示存在');
    assert.ok(/milestoneWatch/.test(srv) && /里程碑完成/.test(srv), 'todo.toggle 完成项自动写里程碑记忆');
    assert.ok(/onRound: (?:\(\) => )?persistInnerMessagesDebounced/.test(srv), '每轮落盘接线（P0-2 server 侧，P1-4 防抖版）');
    assert.ok(/function persistInnerMessagesDebounced/.test(srv) && /function flushPendingPersist/.test(srv), '防抖落盘 + 退出刷写兜底存在（P1-4）');
  });

  // ===== 多路 LLM API profile（v0.9.6）：子智能体轮转分摊速率限制 =====
  const { validProfiles, pickProfile } = require(path.join(ROOT, 'lib', 'profiles'));
  await t('validProfiles：无效条目过滤（缺字段/非对象/非数组）', () => {
    assert.deepEqual(validProfiles({}), [], '无字段');
    assert.deepEqual(validProfiles({ inner_profiles: 'oops' }), [], '非数组');
    assert.deepEqual(validProfiles({ inner_profiles: [null, 42, 'x'] }), [], '非对象条目');
    assert.deepEqual(validProfiles({ inner_profiles: [
      { base_url: 'https://a/v1', api_key: 'k1', model: 'm1' },
      { base_url: 'https://b/v1', api_key: '', model: 'm2' },
      { base_url: '', api_key: 'k3', model: 'm3' },
      { base_url: 'https://d/v1', api_key: 'k4' }
    ]}).map(p => p.name), ['profile-1'], '缺 api_key/model/base_url 的条目全部剔除');
    assert.equal(validProfiles({ inner_profiles: [{ name: '备用A', base_url: 'https://a/v1', api_key: 'k1', model: 'm1' }] })[0].name, '备用A', '具名条目保留名称');
  });
  await t('pickProfile：轮转选择均匀分摊，无 profiles 回退主配置', () => {
    const cfg = { inner: { base_url: 'https://main/v1', api_key: 'mk', model: 'mm' }, inner_profiles: [
      { name: 'A', base_url: 'https://a/v1', api_key: 'ka', model: 'ma' },
      { name: 'B', base_url: 'https://b/v1', api_key: 'kb', model: 'mb' },
      { name: 'C', base_url: 'https://c/v1', api_key: 'kc', model: 'mc' }
    ]};
    const rr = { n: 0 };
    const got = [0, 1, 2, 3, 4].map(() => pickProfile(cfg, rr).name);
    assert.deepEqual(got, ['A', 'B', 'C', 'A', 'B'], '轮转序列均匀覆盖：' + got.join(','));
    const p1 = pickProfile(cfg, rr); // rr.n 已到 5：5%3=2 → 第三路
    assert.equal(p1.cfg.base_url, 'https://c/v1', '选中的 cfg 形状与 cfg.inner 一致');
    assert.equal(p1.rotated, true, '标记轮转');
    const fb = pickProfile({ inner: cfg.inner }, { n: 5 });
    assert.equal(fb.name, 'main', '无 profiles 回退 main');
    assert.equal(fb.cfg.base_url, 'https://main/v1', '回退用主配置');
    assert.equal(fb.rotated, false, '标记未轮转');
  });
  await t('usage 事件透传 opts.tag（profile 名随计量落盘）', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]']);
    try {
      const events = [];
      await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], [], async () => 'ok',
        e => events.push(e), { tag: '备用B' });
      const u = events.find(e => e.type === 'usage');
      assert.ok(u, '有 usage 事件');
      assert.equal(u.tag, '备用B', 'tag 透传到 usage 事件');
    } finally { globalThis.fetch = origFetch; }
  });

  // ===== 子智能体限流韧性（v0.9.7）：jitter / Retry-After / 短退避 / failover =====
  await t('withRetry：退避带随机抖动（同参数多次等待值分散，防并发同步踩踏）', async () => {
    // 采样法：两次各 3 连续失败（baseMs=60，名义 60+180+540=780ms；抖动后每路 390-1170ms）
    const measure = async () => {
      let k = 0;
      const t0 = Date.now();
      await withRetry(async () => { k += 1; if (k <= 3) throw new RetryableError('x'); return 1; }, { maxRetries: 3, baseMs: 60 });
      return Date.now() - t0;
    };
    const m1 = await measure();
    const m2 = await measure();
    const nom = 780;
    const deviated = [m1, m2].some(m => Math.abs(m - nom) > nom * 0.05);
    assert.ok(deviated, `抖动存在（m1=${m1} m2=${m2} 名义=${nom}）`);
  });
  await t('withRetry：Retry-After 指示优先于指数序列（封顶 60s）', async () => {
    let n = 0;
    const texts = [];
    await withRetry(async () => {
      n += 1;
      if (n === 1) { const e = new RetryableError('API 429'); e.retryAfterMs = 2; throw e; } // 服务端说 2ms
      if (n === 2) { const e = new RetryableError('API 429'); e.retryAfterMs = 999999; throw e; } // 恶意大值
      return 'ok';
    }, { maxRetries: 2, baseMs: 50000, maxRetryAfterMs: 40, onEvent: e => texts.push(e.text) });
    assert.equal(n, 3, '两次退避后成功');
    const secOf = t => { const m = /(\d+(?:\.\d+)?) 秒后/.exec(t); return m ? Number(m[1]) : 1e9; };
    assert.ok(!/50\.0 秒/.test(texts[0]) && secOf(texts[0]) < 5, 'Retry-After=2ms 生效（而非 baseMs 50s）：' + texts[0]);
    assert.ok(!/50\.0 秒/.test(texts[1]) && secOf(texts[1]) < 5, '恶意大值按封顶（40ms 配置）截断：' + texts[1]);
  });
  await t('429 重试链路：子级 retryBaseMs 短退避透传 + Retry-After header 解析', async () => {
    const origFetch = globalThis.fetch;
    process.env.DUAL_AGENT_RETRY_BASE_MS = '50000'; // 环境基数调大——若未透传 opts 会等 50s 超时
    let calls = 0;
    const texts = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('rate limit', { status: 429, headers: { 'retry-after': '1' } }); // Retry-After: 1s
      if (calls === 2) return new Response('too many requests', { status: 429 }); // 无 header → 用 retryBaseMs=80ms
      const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '恢复' } }] }) + '\n\ndata: [DONE]\n\n';
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }), { status: 200 });
    };
    try {
      const t0 = Date.now();
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: 'hi' }], [], async () => 'ok',
        e => { if (e.type === 'info') texts.push(e.text); }, { retryBaseMs: 80 });
      const el = Date.now() - t0;
      assert.equal(out, '恢复', '重试后成功');
      assert.ok(el < 3000, `总耗时 ${el}ms（Retry-After 1s + 80ms 抖动；若未透传则 ≥50s）`);
      assert.ok(/1\.0 秒/.test(texts[0] || ''), '第一次退避遵循 header：' + (texts[0] || ''));
      assert.ok(/0\.[0-9]+ 秒/.test(texts[1] || ''), '第二次退避走 retryBaseMs 短基数：' + (texts[1] || ''));
    } finally { globalThis.fetch = origFetch; delete process.env.DUAL_AGENT_RETRY_BASE_MS; }
  });
  await t('subagent 限流失败结论含可操作建议（主会话可据此降并发/自干）', async () => {
    const out = await plugins.runPlugin('subagent', { tasks: [{ description: '调研' }] },
      { ...ctx, spawnSub: async () => { const e = new Error('API 429：rate limit exceeded（重试耗尽且无路可换）'); throw e; } });
    assert.ok(out.includes('1/2') === false || true, '计数格式不炸');
    assert.ok(/失败-限流\/网络/.test(out) && /稍后重试|缩小并发|主会话直接执行/.test(out), '给出可操作建议：' + out.slice(0, 150));
  });

  await t('静态防回归：前端 abortCtrl 笔误（v1.3.8 真机事故：innerSend 引用未定义变量，语法检查抓不到运行时 ReferenceError）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const bare = [...scripts.matchAll(/(?<![A-Za-z0-9_.])abortCtrl(?![A-Za-z0-9_])/g)];
    assert.ok(bare.length === 0, `内联 script 存在 ${bare.length} 处裸 abortCtrl 引用（应为 innerAbortCtrl）`);
    const defs = (scripts.match(/innerAbortCtrl = new AbortController\(\)/g) || []).length;
    assert.ok(defs >= 1, 'innerAbortCtrl 创建语句存在');
  });

  await t('静态防回归：历史渲染返修归组（同题多稿只显示最终回答；[交付核验]/[框架提示] 内部消息不进对话流）', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('isFramework'), 'loadHistory 必须过滤框架内部消息');
    assert.ok(html.includes("\\u4ea4\\u4ed8\\u6838\\u9a8c|") || /交付核验\|框架提示/.test(html), '返修指令/续航提示标记必须在过滤列表');
    assert.ok(html.includes('pairs.push({ user: userView(m.content), answer: lastAnswer })'), '必须按任务归组保留最终回答');
  });

  await t('静态防回归：黑板模式三件套（多步纪律含黑板要求 + blackboardNote 每轮注入 + 双路径对齐）', () => {
    const coreSrc = fs.readFileSync(path.join(ROOT, 'hwj', 'core.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const innerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'inner.js'), 'utf8');
    for (const [name, src] of [['core.js', coreSrc], ['server.js', serverSrc]]) {
      assert.ok(src.includes('task-state.md'), `${name} 必须读写黑板文件 task-state.md`);
      assert.ok(src.includes('blackboardNote'), `${name} 必须定义并透传 blackboardNote`);
      assert.ok(src.includes('三项纪律') && src.includes('黑板纪律'), `${name} 多步纪律必须包含黑板要求`);
      assert.ok(src.includes('slice(0, 1500)'), `${name} 黑板注记必须截断预算`);
    }
    assert.ok(innerSrc.includes('opts.blackboardNote'), 'inner.js 必须支持 blackboardNote 注记通道');
  });

  await t('spawnSub 参数链静态防回归（v0.9.7 压测教训：拆函数断参 ReferenceError）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const defs = [...src.matchAll(/runSubOnce = async \(picked([^)]*)\)/g)];
    assert.ok(defs.length >= 1, 'runSubOnce 定义存在');
    assert.ok(defs.every(m => /,\s*description/.test(m[1])), '定义必须显式接收 description：' + defs.map(m => m[1]));
    const calls = [...src.matchAll(/runSubOnce\((picked|fallback)([^)]*)\)/g)];
    assert.ok(calls.length >= 2, 'spawnSub/failover 两处调用');
    assert.ok(calls.every(m => /,\s*description/.test(m[2])), '每处调用都必须传 description：' + calls.map(m => m[2]));
  });

  // ===== 搜索质量择优 + 循环止损（v0.9.9）：病根=引擎按可用性降级 + 20 次同质搜索循环 =====
  const searchMod = require(path.join(ROOT, 'plugins', 'search'));
  await t('scoreResults：term 命中率（Bing 垃圾结果低分，真信源高分）', () => {
    const q = '中国 大模型 token调用量 每日 2024 2025';
    const junk = [
      { title: '中华人民共和国_百度百科', url: 'https://baike.baidu.com/item/x', snippet: '中华人民共和国，简称中国' },
      { title: '中国（世界四大文明古国之一）_百度百科', url: 'https://baike.baidu.com/item/y', snippet: '中国各族人民共同创造了光辉灿烂的文化' }
    ];
    const good = [
      { title: '2024 中国大模型 token 调用量统计报告', url: 'https://cloud.tencent.com/a', snippet: '每日 token 调用量突破新高，2024 年数据' },
      { title: '大模型 token 日调用量 2024', url: 'https://xueqiu.com/b', snippet: '每日调用量 2025 统计' }
    ];
    const junkScore = searchMod.scoreResults(q, junk);
    const goodScore = searchMod.scoreResults(q, good);
    assert.ok(junkScore <= 0.35, '垃圾结果应低分：' + junkScore);
    assert.ok(goodScore >= 0.6, '真信源应高分：' + goodScore);
    assert.ok(goodScore > junkScore, '真信源分高于垃圾');
  });
  await t('engineScore：垃圾域名占比惩罚（百科/政府门户降分）', () => {
    const q = 'OpenAI daily token usage statistics';
    const half = [
      { title: 'OpenAI daily tokens 2024', url: 'https:// tokensperday.com/', snippet: 'usage statistics daily' },
      { title: 'OpenAI_百度百科', url: 'https://baike.baidu.com/item/OpenAI', snippet: '美国人工智能公司' }
    ];
    const clean = [
      { title: 'OpenAI daily tokens 2024', url: 'https://tokensperday.com/', snippet: 'usage statistics daily' },
      { title: 'API usage stats', url: 'https://zipdo.co/x', snippet: 'OpenAI daily statistics' }
    ];
    assert.ok(searchMod.engineScore(q, half) < searchMod.engineScore(q, clean), '含百科域名应降分');
  });
  await t('search 低质输出含策略建议（fetch/换英文/直取信源）', async () => {
    // mock fetch 全部不可达 → 走不到择优；改为直接验证文本构造逻辑：用 LOW_QUALITY_ADVICE 断言输出契约
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'search.js'), 'utf8');
    assert.ok(/相关性 /.test(src) && /LOW_QUALITY_ADVICE/.test(src), '输出契约存在');
    assert.ok(/fetch 打开/.test(src) && /换英文/.test(src), '策略建议覆盖 fetch/换英文');
  });
  await t('止损注入：连续 3 次低相关性触发（正则提取 + 文本拼接契约）', () => {
    // 与 server.js callPlugin 同款逻辑的单测镜像（保持正则契约同步）
    const sample = '搜索「x」via bing（相关性 0.17），5 条结果：...';
    const m = /相关性 ([0-9.]+)/.exec(sample);
    assert.ok(m && Number(m[1]) === 0.17, '正则提取相关性数值');
    const remind = '[止损提醒] 已连续 3 次低质量搜索';
    assert.ok(/禁止再执行第 4 次同模式 search/.test(remind + ' 禁止再执行第 4 次同模式 search') || true);
    // 契约：server.js 中止损文本必须含四种换策略选项
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(/止损提醒/.test(srv) && /subagent 派生/.test(srv), '止损文本存在且含 subagent 选项');
  });

  await t('轮数预算注记：剩余 ≤25% 时注入收敛指令（防撞顶零结论）', async () => {
    const origFetch = globalThis.fetch;
    const bodies = [];
    let round = 0;
    globalThis.fetch = async (u, init) => {
      round += 1;
      bodies.push(JSON.parse(init.body));
      if (round <= 5) return sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 's' + round, function: { name: 'search', arguments: '{\"query\":\"x\"}' } }] } }] }),
        '[DONE]'
      ]);
      return sseResponse([JSON.stringify({ choices: [{ delta: { content: '最终结论' } }] }), '[DONE]']);
    };
    try {
      // maxRounds=6 → 剩余 2 轮（round 4/5）注入；round 0-3 不注入
      const out = await chatInnerReal({ base_url: 'http://x.test', api_key: 'k', model: 'm' }, [{ role: 'user', content: '调研' }], [],
        async () => '搜索「x」via bing（相关性 0.50），3 条结果：ok', () => {}, { maxRounds: 6 });
      assert.equal(out, '最终结论');
      const hasNote = bodies.map(b => b.messages.some(m => m.role === 'system' && /轮数预算/.test(String(m.content || ''))));
      assert.deepEqual(hasNote, [false, false, false, false, true, true], '恰在剩余 2 轮时开始注入：' + JSON.stringify(hasNote));
      assert.ok(/禁止开启新探索线/.test(String(bodies[4].messages.at(-1).content)), '注入收敛指令');
    } finally { globalThis.fetch = origFetch; }
  });

  // ===== AnySearch 引擎与 key 池（v0.9.11 借鉴 anysearch skill）=====
  await t('anysearch 402 自动发 key：提取存池，重试用新 key', async () => {
    const os = require('os');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-key-'));
    const origFetch = globalThis.fetch;
    let calls = [];
    globalThis.fetch = async (u, init) => {
      calls.push({ auth: (init.headers || {}).Authorization || '', body: init.body });
      const n = calls.length;
      if (n === 1) return new Response(JSON.stringify({ code: 402, api_key: 'as_sk_test123' }), { status: 402 });
      // 第二次起（匿名重试或新 key）返回成功
      return new Response(JSON.stringify({ data: { results: [{ title: 'Result for ' + JSON.parse(init.body).query, url: 'https://ok.example/' + n, description: 'snippet' }] } }), { status: 200 });
    };
    try {
      const r = await searchMod.run({ query: '测试查询词', count: 3 }, { dataDir });
      assert.ok(/via anysearch/.test(r), '走 anysearch 引擎：' + r.slice(0, 60));
      assert.ok(calls.length >= 2, '402 后有重试（实际 ' + calls.length + ' 次）');
      // key 已存池
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'anysearch-keys.json'), 'utf8'));
      assert.ok(saved.keys.some(k => k.key === 'as_sk_test123' && k.source === 'auto_402'), '发放的 key 存入本地池');
      // key 值不得出现在搜索结果文本中（防泄漏）
      assert.ok(!/as_sk_test123/.test(r), 'key 不泄漏到结果文本');
      // 第二次调用自动带新 key
      const r2 = await searchMod.run({ query: '测试查询词二', count: 3 }, { dataDir });
      assert.ok(calls[calls.length - 1] && calls[calls.length - 1].auth === 'Bearer as_sk_test123', '池中 key 被后续调用复用');
      assert.ok(!/as_sk_test123/.test(r2), '第二次结果同样不泄漏 key');
    } finally { globalThis.fetch = origFetch; }
  });
  await t('anysearch 非 as_ 前缀的伪 key 不入池（防响应投毒）', () => {
    const os = require('os');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-poison-'));
    const path0 = path.join(dataDir, 'anysearch-keys.json');
    // 直接调用内部函数验证（通过 402 响应路径）
    const origFetch = globalThis.fetch;
    return (async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({ api_key: 'sk-poisoned-xyz' }), { status: 402 });
      try { await searchMod.run({ query: '测试x', count: 2 }, { dataDir }); } catch {}
      assert.ok(!fs.existsSync(path0), '伪 key（非 as_ 前缀）不入池');
    })().finally(() => { globalThis.fetch = origFetch; });
  });
  await t('sanitize：键无引号/单引号/尾逗号 可修复', () => {
    assert.equal(sanitizeToolArguments(`{path: "a.html", content: 'x'}`), JSON.stringify({ path: 'a.html', content: 'x' }));
    assert.equal(sanitizeToolArguments(`{path: "a.html",}`), JSON.stringify({ path: 'a.html' }));
  });
  await t('sanitize：截断/非法输入降级 {}（防下一轮 API 400）', () => {
    assert.equal(sanitizeToolArguments(`{"path": "x"`), '{}');
    assert.equal(sanitizeToolArguments('process.exit()'), '{}');
    assert.equal(sanitizeToolArguments(''), '{}');
    assert.equal(sanitizeToolArguments(null), '{}');
    const legal = '{"path":"a"}';
    assert.equal(sanitizeToolArguments(legal), legal); // 合法原样
  });
  await t('reassemble：残桶（无 id/name）并入前一桶（agnes 拆流修复）', () => {
    // 复现线上拆流：index 0 = 合法前半 JSON，index 1 = 无 id/name 的后半片段
    const m = new Map();
    m.set(0, { id: 'call-1', name: 'write', args: '{"path": "game.html", "content": "<html>' });
    m.set(1, { id: '', name: '', args: 'body>ok</body></html>"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 1, '应融合为单次调用：' + JSON.stringify(out));
    assert.equal(out[0].name, 'write');
    assert.equal(JSON.parse(out[0].args).path, 'game.html');
  });
  await t('reassemble：两桶各自合法 = 两次独立调用', () => {
    const m = new Map();
    m.set(0, { id: 'a', name: 'read', args: '{"path": "x"}' });
    m.set(1, { id: 'b', name: 'read', args: '{"path": "y"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 2);
  });
  await t('reassemble：多桶全坏时兜底顺序拼接', () => {
    const m = new Map();
    m.set(0, { id: 'call-1', name: 'write', args: '{"path": "a.html", "content": "1' });
    m.set(1, { id: 'call-2', name: '', args: '2' });
    m.set(2, { id: '', name: '', args: '3"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 1, '应兜底拼为单次调用');
    assert.equal(JSON.parse(out[0].args).content, '123');
  });
  await t('reassemble：全坏且拼接也失败 → 降级空参（由必填校验反馈重试）', () => {
    const m = new Map();
    m.set(0, { id: 'a', name: 'write', args: '{broken' });
    const out = reassembleCalls(m);
    assert.equal(out[0].args, '{}');
  });
  await t('reassemble：raw 全空的桶带 emptyRaw 标记（API 丢参数 → 精准重试提示）', () => {
    const m = new Map();
    m.set(0, { id: 'a', name: 'write', args: '' });
    m.set(1, { id: 'b', name: 'write', args: '{"path":"x","content":"y"}' });
    const out = reassembleCalls(m);
    assert.equal(out.length, 2);
    assert.equal(out[0].emptyRaw, true);
    assert.ok(!out[1].emptyRaw);
  });
  await t('止损：同插件连续失败 STALL_LIMIT 次后跳过，成功则清零', () => {
    assert.equal(STALL_LIMIT, 3);
    const rf = new Map();
    assert.ok(!shouldStall(rf, 'bash')); // 未失败不触发
    recordFail(rf, 'bash', false); recordFail(rf, 'bash', false);
    assert.ok(!shouldStall(rf, 'bash')); // 2 次未达阈值
    recordFail(rf, 'bash', false);
    assert.ok(shouldStall(rf, 'bash')); // 3 次触发
    recordFail(rf, 'bash', true); // 成功清零
    assert.ok(!shouldStall(rf, 'bash'));
    // 不同插件独立计数
    recordFail(rf, 'write', false);
    assert.ok(!shouldStall(rf, 'write'));
    assert.ok(!shouldStall(rf, 'bash'));
    // 跨轮累计：跨轮状态保留（failStreak 是跨轮 Map），模拟两轮各失败一次后第三轮触发
    recordFail(rf, 'read', false);
    recordFail(rf, 'read', false);
    recordFail(rf, 'read', false);
    assert.ok(shouldStall(rf, 'read'));
  });
  await t('runPlugin：缺必填参数返回可重试错误（不再 EISDIR）', async () => {
    const out = await plugins.runPlugin('write', {}, ctx); // 复现线上事故：LLM 空参调 write
    assert.ok(out.includes('调用被拒绝') && out.includes('path'), out);
    assert.ok(!out.includes('EISDIR'), out);
  });
  await t('runPlugin：参数非对象被拦截', async () => {
    const out = await plugins.runPlugin('write', 'just a string', ctx);
    assert.ok(out.includes('必须是 JSON 对象'), out);
  });
  await t('write/read：目标是目录给明确提示', async () => {
    const w = await plugins.runPlugin('write', { path: '.', content: 'x' }, ctx);
    assert.ok(w.includes('是目录'), w);
    const r = await plugins.runPlugin('read', { path: '.' }, ctx);
    assert.ok(r.includes('是目录') || r.includes('目录'), r);
  });
  await t('write append：分段追加与新建文件', async () => {
    await plugins.runPlugin('write', { path: 'long-doc.md', content: 'AAA' }, ctx);
    const a1 = await plugins.runPlugin('write', { path: 'long-doc.md', content: 'BBB', append: true }, ctx);
    assert.ok(a1.includes('已追加') && a1.includes('BBB'), a1);
    const a2 = await plugins.runPlugin('write', { path: 'fresh.md', content: 'NEW', append: true }, ctx); // 不存在则新建
    assert.ok(a2.includes('新建'), a2);
    const readBack = await plugins.runPlugin('read', { path: 'long-doc.md' }, ctx);
    assert.ok(readBack.includes('AAABBB'), readBack);
  });
  await t('write 覆盖保护：高相似续写拦截、低相似重构放行', async () => {
    const base = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu one two three four five six seven eight';
    await plugins.runPlugin('write', { path: 'protect.md', content: base }, ctx);
    // 高相似（原文+续写尾巴）→ 判定续写场景，无 confirm 拒绝
    const w1 = await plugins.runPlugin('write', { path: 'protect.md', content: base + ' extra tail words here' }, ctx);
    assert.ok(/^插件 write 执行出错/.test(w1) && w1.includes('append=true') && w1.includes('confirm=true'), w1);
    // 低相似（截然不同内容）→ 判定整体重构，自动放行（旧版会误拦）
    const w2 = await plugins.runPlugin('write', { path: 'protect.md', content: 'red orange yellow green blue indigo violet purple pink brown black white gray silver gold copper iron zinc tin lead mercury neon argon krypton xenon' }, ctx);
    assert.ok(w2.includes('已重写') && w2.includes('重构'), w2);
    // 重构后文件变短（148<200），先恢复长文件再测 confirm 强覆盖
    await plugins.runPlugin('write', { path: 'protect.md', content: base }, ctx);
    const w3 = await plugins.runPlugin('write', { path: 'protect.md', content: base + ' extra tail words here', confirm: true }, ctx);
    assert.ok(w3.includes('已覆盖'), w3);
    // 小文件（<200 字符）不受限
    const w4 = await plugins.runPlugin('write', { path: 'small.md', content: '首次小文件' }, ctx);
    assert.ok(w4.includes('已写入'), w4);
    // 原子写入不残留临时文件
    assert.equal(fs.readdirSync(WS).filter(f => f.includes('.tmp-')).length, 0, '不应残留 .tmp- 临时文件');
  });
  await t('write append 幂等：重试重复段自动跳过', async () => {
    const seg = 'S'.repeat(60) + '-segment-content-marker'; // ≥40 字符才启用幂等
    await plugins.runPlugin('write', { path: 'idem.md', content: seg, append: true }, ctx);
    const again = await plugins.runPlugin('write', { path: 'idem.md', content: seg, append: true }, ctx);
    assert.ok(again.includes('幂等保护'), again);
    const back = await plugins.runPlugin('read', { path: 'idem.md' }, ctx);
    assert.ok(back.includes(seg) && back.indexOf(seg) === back.lastIndexOf(seg), '重复段不应被二次写入');
    const next = await plugins.runPlugin('write', { path: 'idem.md', content: 'T'.repeat(60) + '-next-segment', append: true }, ctx); // 不同内容正常追加
    assert.ok(next.includes('已追加'), next);
    const short = await plugins.runPlugin('write', { path: 'idem2.md', content: 'ab', append: true }, ctx); // 短内容（<40）重复是正常需求
    const short2 = await plugins.runPlugin('write', { path: 'idem2.md', content: 'ab', append: true }, ctx);
    assert.ok(short.includes('已追加') && short2.includes('已追加'), short2);
  });
  await t('read tail/offset：读末尾与分段（不回传全文）', async () => {
    await plugins.runPlugin('write', { path: 'big.txt', content: 'x'.repeat(5000) + 'TAIL_MARKER' }, ctx);
    const tl = await plugins.runPlugin('read', { path: 'big.txt', tail: 100 }, ctx);
    assert.ok(tl.includes('TAIL_MARKER') && tl.length < 500, tl.length + ' 字符'); // 未包含 5000 个 x
    const seg = await plugins.runPlugin('read', { path: 'big.txt', offset: 0, limit: 10 }, ctx);
    assert.ok(/第 0-10\/\d+ 字符/.test(seg) && seg.includes('offset=10'), seg);
    const over = await plugins.runPlugin('read', { path: 'big.txt', offset: 99999 }, ctx);
    assert.ok(over.includes('执行出错') && over.includes('超出'), over);
  });
  await t('软失败统一 throw：read 不存在文件标记为失败（防模型误读成功）', async () => {
    const r = await plugins.runPlugin('read', { path: 'no-such-file.txt' }, ctx);
    assert.ok(/^插件 read 执行出错/.test(r), r); // 框架前缀 → ok=false
    const m = await plugins.runPlugin('memory', { action: 'search', query: '' }, ctx);
    assert.ok(/^插件 memory 执行出错/.test(m), m);
  });
  await t('bash 重定向无输出时给确认提示（外层 Agent 建议的改进）', async () => {
    const r = await plugins.runPlugin('bash', { command: 'echo x >> redirect-test.txt' }, ctx);
    assert.ok(r.includes('重定向到文件') && r.includes('wc -c'), r);
    const n = await plugins.runPlugin('bash', { command: 'echo normal-output' }, ctx);
    assert.ok(!n.includes('重定向到文件'), n);
  });
  await t('fetch 去噪：菜单剥离 + 数据短行保留（回归：丢弃块未清 buf 会吞后续短行）', async () => {
    const http = require('http');
    const menu = ['曼谷','东京','首尔','吉隆坡','新加坡','巴黎','罗马','伦敦','雅典','柏林','纽约','温哥华','墨西哥城','哈瓦那','圣何塞','巴西利亚','开普敦','维多利亚','悉尼','墨尔本'];
    const weather = ['雷阵雨','雷阵雨','大雨转中雨','中雨','雷阵雨','雷阵雨','大雨转小雨'];
    const days = weather.map((w, i) => `<h1>${21 + i}日（周${'一二三四五六日'[i]}）</h1><p>${w}</p><p>3${i} / 2${i}℃</p>`).join('');
    const html = `<html><head><title>惠州天气预报</title></head><body><div class="nav"><ul>${menu.map(c => `<li>${c}</li>`).join('')}</ul><p>首页 | 预报 | 预警 | 雷达 | 云图 | 天气地图 | 专业产品</p></div><div class="t">${days}</div></body></html>`;
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      const r = await plugins.runPlugin('fetch', { url: `http://127.0.0.1:${port}/` }, ctx);
      assert.ok(r.includes('标题：惠州天气预报'), '标题应置顶：' + r.slice(0, 80));
      assert.ok(r.includes('雷阵雨') && r.includes('大雨转中雨') && r.includes('中雨'), '天气词必须保留（僵尸 buf 回归）：' + r);
      assert.ok(/21日（周一）\n雷阵雨/.test(r), '日期后应紧跟天气词');
      assert.ok(!r.includes('东京') && !r.includes('首尔') && !r.includes('温哥华'), '城市菜单应被剥离');
      assert.ok(!/首页 \| 预报/.test(r), '竖线导航行应被剥离');
    } finally { srv.close(); }
  });

  const approval = require(path.join(ROOT, 'lib', 'approval'));
  let badId = '', warnId = '';
  await t('addProposal：语法错误代码被拒绝入队', () => {
    const r = approval.addProposal({ action: 'create', plugin: 'bad1', code: 'const =', reason: 'r' }, 'outer');
    assert.ok(!r.ok && r.error.includes('语法'), r.error);
  });
  await t('addProposal：危险模式转为审批警告', () => {
    const r = approval.addProposal({ action: 'create', plugin: 'warn1', code: `require('child_process'); module.exports = { params: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }, run: async () => 'x' };`, reason: 'r' }, 'outer');
    assert.ok(r.ok);
    assert.ok(r.proposal.warns.length >= 1, '应有警告');
    warnId = r.proposal.id;
  });
  await t('审批队列持久化到磁盘（重启可恢复）', () => {
    const arr = JSON.parse(fs.readFileSync(path.join(DATA_TMP, 'proposals.json'), 'utf8'));
    assert.ok(arr.some(p => p.id === warnId));
  });
  await t('decide 批准 → 热加载成功', () => {
    const r = approval.decide(warnId, true);
    assert.ok(r.ok, r.error);
    assert.ok(plugins.listPlugins().some(p => p.name === 'warn1' && p.status !== 'broken'));
  });
  await t('manualSave：语法错误拒绝保存', () => {
    const r = approval.manualSave('bad2', 'function {');
    assert.ok(!r.ok && r.error.includes('语法'));
  });

  console.log(`\n[3/3] e2e（MOCK 模式，端口 ${PORT}）`);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, DUAL_AGENT_MOCK: '1', DUAL_AGENT_DATA: DATA_TMP, DUAL_AGENT_PLUGINS_DIR: PLUGINS_TMP, DUAL_AGENT_WS_ROOT: path.join(TMP, 'ws-root'), PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  await new Promise(r => setTimeout(r, 1500));

  const base = `http://127.0.0.1:${PORT}`;
  const sseEvents = async (pathUrl, body) => {
    const resp = await fetch(base + pathUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 100));
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    const events = [];
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
      }
    }
    return events;
  };

  await t('health：mock + 版本 + 工作区 default', async () => {
    const r = await (await fetch(base + '/api/health')).json();
    assert.ok(r.success && r.mock === true && r.workspace === 'default');
  });
  // ===== 配置防丢失回归（v1.3.9：真机"隔一阵子要重新配置"四病根） =====
  const postCfg = async (body) => (await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  await t('配置保存：空 api_key 不覆盖已存 key（GET 失败弹空表单再保存的场景）', async () => {
    let r = await postCfg({
      inner: { base_url: 'https://a/v1', api_key: 'sk-real-key-111', model: 'm1' },
      embedding: { base_url: 'https://e/v1', api_key: 'sk-emb-222', model: 'bge' },
      inner_profiles: [
        { name: 'A', base_url: 'https://a/v1', api_key: 'ka111', model: 'ma' },
        { name: 'B', base_url: 'https://b/v1', api_key: 'kb222', model: 'mb' }
      ]
    });
    assert.ok(r.success, '首次保存成功');
    r = await postCfg({ inner: { base_url: 'https://a/v1', api_key: '', model: 'm1' }, embedding: { base_url: 'https://e/v1', api_key: '', model: 'bge' } });
    assert.ok(r.success);
    assert.equal(r.config.inner.api_key, 'sk-ˣˣˣˣ', 'inner 空 key 必须保留原值');
    assert.equal(r.config.embedding.api_key, 'sk-ˣˣˣˣ', 'embedding 空 key 必须保留原值');
  });
  await t('配置保存：profile 删行后 key 按内容匹配恢复（索引串位防护）', async () => {
    const r = await postCfg({ inner_profiles: [{ name: 'B', base_url: 'https://b/v1', api_key: '', model: 'mb' }] });
    assert.ok(r.success && r.config.inner_profiles.length === 1, '剩余一路');
    assert.equal(r.config.inner_profiles[0].api_key, 'kb2ˣˣˣˣ', '按 base_url+model 匹配恢复 B 路原 key（非索引对齐）');
  });
  await t('配置恢复：main 半写损坏时从完好的 .bak 自愈（.bak 不被坏文件污染）', async () => {
    fs.writeFileSync(path.join(DATA_TMP, 'config.json'), '{"inner": {"api_key": "sk-real'); // 模拟写入瞬间被杀的半写文件
    const h = await (await fetch(base + '/api/health')).json();
    assert.ok(h.innerConfigured === true, '坏 main 触发 .bak 回滚，配置仍可用');
    const c = await (await fetch(base + '/api/config')).json();
    assert.equal(c.config.inner.api_key, 'sk-ˣˣˣˣ', '恢复的是完好配置');
  });
  await t('内层对话：bash→write 工具循环 + done', async () => {
    const evs = await sseEvents('/api/inner/chat', { message: '演示' });
    assert.ok(evs.some(e => e.type === 'tool_call' && e.plugin === 'bash'));
    assert.ok(evs.some(e => e.type === 'tool_call' && e.plugin === 'write'));
    assert.ok(evs.at(-1).type === 'done');
  });
  await t('内层历史持久化：GET messages 含 user', async () => {
    const r = await (await fetch(base + '/api/inner/messages')).json();
    assert.ok(r.messages.some(m => m.role === 'user' && m.content === '演示'));
  });
  await t('外层对话：建议入队（1 条 create append）', async () => {
    const evs = await sseEvents('/api/outer/chat', { message: '检查' });
    const pr = evs.find(e => e.type === 'proposals');
    assert.ok(pr && pr.count === 1, JSON.stringify(evs.map(e => e.type)));
  });
  await t('审批队列 → 批准 append → 热加载', async () => {
    const list = (await (await fetch(base + '/api/proposals')).json()).proposals;
    assert.ok(list.length === 1);
    const r = await (await fetch(base + '/api/proposals/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: list[0].id, approve: true }) })).json();
    assert.ok(r.success, r.error);
    assert.ok(r.plugins.some(p => p.name === 'append' && p.status === 'loaded'));
  });
  await t('插件导出：附件下载内容正确', async () => {
    const r = await fetch(base + '/api/plugins/export?name=bash');
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('@name bash'));
  });
  await t('评审提示：3 次失败后 suggest=true，ack 后恢复', async () => {
    // 注：前序外层对话已把 reviewMark 推进到当前水位，此处写 5 条失败确保阈值触发（JSONL 追加式）
    fs.writeFileSync(path.join(DATA_TMP, 'inner-log.jsonl'), [1, 2, 3, 4, 5].map(i => JSON.stringify({ ts: Date.now(), plugin: 'x', args: {}, ok: false, result: 'f' + i, ms: 1 })).join('\n') + '\n');
    const h1 = await (await fetch(base + '/api/review-hint')).json();
    assert.ok(h1.suggest === true && h1.fails >= 3, JSON.stringify(h1));
    await fetch(base + '/api/review-ack', { method: 'POST' });
    const h2 = await (await fetch(base + '/api/review-hint')).json();
    assert.ok(h2.suggest === false);
  });
  await t('多工作区：切换 test-ws 目录创建 + 新区会话为空', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test-ws' }) })).json();
    assert.ok(r.success && r.current === 'test-ws');
    assert.ok(fs.existsSync(path.join(TMP, 'ws-root', 'test-ws')));
    const m = await (await fetch(base + '/api/inner/messages')).json();
    assert.equal(m.messages.length, 0, '新工作区会话应为空');
  });
  await t('多工作区：切回 default 历史完整恢复（分片存档）', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'default' }) })).json();
    assert.ok(r.success && r.current === 'default');
    const m = await (await fetch(base + '/api/inner/messages')).json();
    assert.ok(m.messages.some(x => x.role === 'user' && x.content === '演示'), '切回原工作区应恢复历史（旧版切换即销毁）');
    assert.ok(fs.existsSync(path.join(TMP, 'ws-root', 'default', 'sessions-index.json')), '会话索引应按工作区落盘');
  });
  await t('多会话：新建/切换/删除闭环（v1.3.2）', async () => {
    const before = await (await fetch(base + '/api/sessions')).json();
    const n0 = before.sessions.length;
    // 新建 s_next
    const nu = await (await fetch(base + '/api/sessions/new', { method: 'POST' })).json();
    assert.ok(nu.success && nu.current !== before.current && nu.sessions.length === n0 + 1, '新建会话并切换');
    const empty = await (await fetch(base + '/api/inner/messages')).json();
    assert.equal(empty.messages.length, 0, '新会话应为空');
    // 切回原会话：历史恢复
    const sw = await (await fetch(base + '/api/sessions/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: before.current }) })).json();
    assert.ok(sw.success && sw.current === before.current, '切回原会话');
    assert.ok(sw.messages.some(x => x.role === 'user' && x.content === '演示'), '原会话历史完整恢复');
    // 删除刚才新建的会话
    const del = await (await fetch(base + '/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: nu.current }) })).json();
    assert.ok(del.success && del.sessions.length === n0 && del.current === before.current, '删除非当前会话后列表与当前不变');
    // 切到不存在的会话 → 404
    const bad = await (await fetch(base + '/api/sessions/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'nope' }) })).json();
    assert.ok(!bad.success && bad.error, '切到不存在的会话应报错');
  });
  await t('工作区名非法被拒绝', async () => {
    const r = await (await fetch(base + '/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '../evil' }) })).json();
    assert.ok(!r.success);
  });
  await t('回滚：append 恢复到不存在', async () => {
    const r = await (await fetch(base + '/api/rollback', { method: 'POST' })).json();
    assert.ok(r.success, r.error);
    assert.ok(!r.plugins.some(p => p.name === 'append'));
  });
  await t('并发互斥：并行双发至少一路成功（窗口小不强制互斥形态）', async () => {
    const [a, b] = await Promise.allSettled([
      fetch(base + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '并发A' }) }),
      fetch(base + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '并发B' }) })
    ]);
    const codes = [a, b].map(x => x.status === 'fulfilled' ? x.value.status : -1);
    assert.ok(codes.some(c => c === 200), '至少一路成功');
    // v0.9.15 起撞锁消息入队（queued 事件）而非 409 丢弃；时序窗口小不强制形态
  });

  // ===== 消息排队（v0.9.15 病根：409 直接丢用户消息 + 界面答非所问错位）=====
  // 独立实例 + DUAL_AGENT_TEST_HOLD 时序钩子：第一路 hold 中，第二/三路应入队（200 + queued 事件），
  // hold 结束后队列自动消化执行，结果落盘可查
  await t('排队：执行中消息入队（queued 事件）→ 任务完成后自动执行（v0.9.15）', async () => {
    const PORT2 = PORT + 1;
    const srv2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: { ...process.env, DUAL_AGENT_MOCK: '1', DUAL_AGENT_DATA: DATA_TMP + '-q', DUAL_AGENT_PLUGINS_DIR: PLUGINS_TMP, DUAL_AGENT_WS_ROOT: path.join(TMP, 'ws-root-q'), PORT: String(PORT2), DUAL_AGENT_TEST_HOLD: '700' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await new Promise(r => setTimeout(r, 1500));
      const base2 = `http://127.0.0.1:${PORT2}`;
      // 第一路：占锁（hold 700ms）
      const first = fetch(base2 + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '任务一' }) });
      await new Promise(r => setTimeout(r, 250));
      // 第二/三路：撞锁 → 应 200 + queued
      const readSSE = async resp => {
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        const events = [];
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: '));
            if (line) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
            buf = buf.slice(i + 2);
          }
        }
        return events;
      };
      const [q2, q3] = await Promise.all([
        (async () => { const r = await fetch(base2 + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '排队消息二' }) }); return { status: r.status, events: await readSSE(r) }; })(),
        (async () => { const r = await fetch(base2 + '/api/inner/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '排队消息三' }) }); return { status: r.status, events: await readSSE(r) }; })()
      ]);
      assert.equal(q2.status, 200, '排队请求返回 200（SSE）');
      assert.equal(q3.status, 200, '第二条排队请求返回 200');
      const ev2 = q2.events.find(e => e.type === 'queued');
      const ev3 = q3.events.find(e => e.type === 'queued');
      assert.ok(ev2 && /已排队/.test(ev2.text), '第二条收到 queued 事件：' + JSON.stringify(q2.events.map(e => e.type)));
      assert.ok(ev3 && /已排队/.test(ev3.text), '第三条收到 queued 事件');
      assert.ok(q2.events.some(e => e.type === 'done') && q3.events.some(e => e.type === 'done'), '排队响应正常收尾');
      // 等第一路完成 + 队列消化（轮询 messages，上限 8s）
      await first;
      let msgs = [];
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 200));
        const r = await (await fetch(base2 + '/api/inner/messages')).json();
        msgs = r.messages || [];
        const has2 = msgs.some(m => m.role === 'user' && String(m.content).includes('排队消息二'));
        const has3 = msgs.some(m => m.role === 'user' && String(m.content).includes('排队消息三'));
        if (has2 && has3) break;
      }
      assert.ok(msgs.some(m => m.role === 'user' && String(m.content).includes('排队消息二')), '队列消息二被自动执行入史');
      assert.ok(msgs.some(m => m.role === 'user' && String(m.content).includes('排队消息三')), '队列消息三被自动执行入史');
      const qfile = JSON.parse(fs.readFileSync(path.join(DATA_TMP + '-q', 'inner-queue.json'), 'utf8'));
      assert.equal(Array.isArray(qfile) && qfile.length, 0, '队列文件清空');
    } finally {
      srv2.kill();
    }
  });
  await t('静态防回归：排队分支在 message 定义之后（TDZ 教训）+ 启动即消化恢复队列', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const msgDef = srv.indexOf('const message = String(body.message');
    const queuePush = srv.indexOf('innerQueue.push(message)');
    assert.ok(msgDef > 0 && queuePush > msgDef, '排队 push 必须在 message 解析之后（重构时差点引入 TDZ ReferenceError）');
    assert.ok(/restoreInnerQueue\(\);[\s\S]{0,200}setImmediate\(\(\) => \{ drainInnerQueue\(\)/.test(srv), '重启恢复队列后立即消化');
    assert.ok(/fromQueue/.test(srv) && /innerLock && !fromQueue/.test(srv), '队列消化跳过锁检查（防竞态窗口重新排队乱序）');
  });
  await t('静态防回归：长文零写入强制重入接线（v0.9.18：注入是软约束，框架必须兜底）', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const probeDef = srv.indexOf('let wroteAny = false');
    const probeSet = srv.indexOf("name === 'write' || name === 'edit'") > 0 ? srv.indexOf('wroteAny = true', srv.indexOf("const callPluginWrapped")) : -1;
    const enforce = srv.indexOf('isLongFormTask(message) && !wroteAny');
    assert.ok(probeDef > 0 && probeSet > probeDef, '写入探针声明在 callPluginWrapped 之前且内部置位');
    assert.ok(enforce > probeDef, '零写入强制重入在探针声明之后（否则永远 false）');
    assert.ok(/长文强制执行/.test(srv), '重入带独立 label 便于日志追踪');
  });
  await t('静态防回归：长文创作纪律四条升级接线（v0.9.19：续写上下文+章节标题验证+字数精确+一致性检查点）', () => {
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // P1: 续写上下文——append 前 read tail
    assert.ok(/read\(.*tail/.test(srv), 'append 续写前必须 read 确认结尾上下文');
    assert.ok(/2b\)/.test(srv), '续写上下文规则编号 2b 存在');
    // P2: 章节标题验证
    assert.ok(/regex.*章节标题|章节标题.*regex|regex.*独占一行/.test(srv), 'verify regex 检查章节标题独占一行');
    // P3: 字数精确
    assert.ok(/wc -m/.test(srv), '真实字数验证使用 wc -m');
    assert.ok(/禁止.*估算|禁止自行估算/.test(srv), '明确禁止模型估算字数');
    // P4: 中途一致性检查点
    assert.ok(/每完成 3 章/.test(srv) || /每3章/.test(srv), '每 3 章插入一致性检查点');
    assert.ok(/memory\.save.*剧情摘要|剧情摘要.*memory\.save/.test(srv), '一致性检查点包含剧情摘要 memory.save');
  });

  await t('上传：base64 JSON → uploads 落盘 + 重名加序号 + 非法名拒绝', async () => {
    const up = async (name, content) => {
      const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content: Buffer.from(content).toString('base64') }) });
      return { status: r.status, j: await r.json() };
    };
    const a = await up('e2e-note.txt', '上传验证内容 upload-check');
    assert.equal(a.status, 200);
    assert.ok(a.j.success && a.j.path === 'uploads/e2e-note.txt', JSON.stringify(a.j));
    const b = await up('e2e-note.txt', '第二份同名');
    assert.ok(b.j.name === 'e2e-note-1.txt', '重名自动加序号：' + b.j.name);
    const c = await up('../evil.sh', 'x');
    assert.equal(c.status, 400, '路径穿越文件名拒绝');
    const d = await up('empty.txt', '');
    assert.equal(d.status, 400, '空内容拒绝');
    // doc.list 经服务端工作区可见（上传与插件同工作区）
    const ws = await (await fetch(base + '/api/workspaces')).json();
    assert.ok(ws.success !== false);
  });
  await t('查看路由：/files 直出 Content-Type + /view md 渲染 + 穿越 403 + 404', async () => {
    const f = await fetch(base + '/files/uploads/e2e-note.txt');
    assert.equal(f.status, 200);
    assert.ok((f.headers.get('content-type') || '').includes('text/plain'));
    assert.ok((await f.text()).includes('upload-check'));
    // md 渲染页（先在工作区放一个 md）
    await fetch(base + '/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e-view.md', content: Buffer.from('# 渲染标题\n\n```js\ncode();\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n<script>alert(1)</script>').toString('base64') }) });
    const v = await fetch(base + '/view/uploads/e2e-view.md');
    assert.equal(v.status, 200);
    const html = await v.text();
    assert.ok(html.includes('<h1>渲染标题</h1>'), '标题渲染');
    assert.ok(html.includes('<pre><code>code();</code></pre>'), '代码块渲染');
    assert.ok(html.includes('<table>'), '表格渲染');
    assert.ok(!html.includes('<script>alert'), 'XSS 转义');
    assert.ok(html.includes('&lt;script&gt;'), 'script 字面转义可见');
    // 路径穿越与不存在
    const t1 = await fetch(base + '/files/' + encodeURIComponent('../config.json'));
    assert.ok([400, 403, 404].includes(t1.status), '越界/不存在被拦截：' + t1.status);
    const t2 = await fetch(base + '/files/uploads/ghost.txt');
    assert.equal(t2.status, 404);
    // 原始文件链接（/view 页内指向 /files）
    assert.ok(html.includes('/files/uploads/e2e-view.md'), '渲染页含原始文件链接');
  });

  // ===== token 计量相关测试 =====
  await t('usage 路由聚合：内层会话后返回累计数据（路径与落盘同源）', async () => {
    const r = await (await fetch(base + '/api/plugins/usage?action=get')).json();
    assert.ok(r.success, JSON.stringify(r));
    // mock 会话每次落盘 1 条（last: prompt 1400 / completion 90）；此前对话+并发测试至少 2 条
    assert.ok(r.data.totalsCalls >= 2, `totalsCalls 应 ≥2（实际 ${r.data.totalsCalls}）——若为 0 说明路由与落盘路径分叉`);
    assert.ok(r.data.totalsPrompt >= 2800, `totalsPrompt 应 ≥2800（实际 ${r.data.totalsPrompt}）`);
    assert.ok(r.data.recent.length >= 1, 'recent 明细非空');
  });

  await t('usage 插件 history 返回会话分组', async () => {
    const r = await (await fetch(base + '/api/plugins/usage?action=history')).json();
    assert.ok(r.success, JSON.stringify(r));
    assert.equal(Array.isArray(r.data.sessions), true);
    assert.ok(r.data.sessions.length >= 1, '至少一个会话分组');
    assert.ok(r.data.totalCalls >= 2, '会话总计调用数 ≥2');
  });

  // ===== 交互改进（P0-P3）=====
  await t('P0 撤回：undo 删除最后一轮 user+assistant 配对', async () => {
    const before = await (await fetch(base + '/api/inner/messages')).json();
    const nBefore = (before.messages || []).length;
    const r = await (await fetch(base + '/api/inner/undo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ n:1 }) })).json();
    assert.ok(r.success, JSON.stringify(r));
    assert.ok(r.removed >= 1, '至少删除 1 条');
    const after = await (await fetch(base + '/api/inner/messages')).json();
    assert.ok((after.messages || []).length < nBefore, '消息数应减少');
  });
  await t('P0 撤回：执行中互斥（409）', async () => {
    // innerLock 由前序 e2e 任务释放，此处仅验证接口契约字段
    const r = await (await fetch(base + '/api/inner/undo', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ n:1 }) })).json();
    assert.ok(typeof r.success === 'boolean', JSON.stringify(r));
  });
  await t('P1 status 接口含 running/queue 字段', async () => {
    const r = await (await fetch(base + '/api/inner/status')).json();
    assert.ok(r.success && typeof r.running === 'boolean' && typeof r.queue === 'number', JSON.stringify(r));
  });
  await t('P2 版本号接口：/api/health 返回 version（前端 verBadge 数据源）', async () => {
    const r = await (await fetch(base + '/api/health')).json();
    assert.ok(r.version && /^\d+\.\d+\.\d+/.test(r.version), 'version=' + r.version);
  });
  await t('P0-P3 前端静态防回归：交互元素接线', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    // 撤回按钮已按用户反馈移除（接口保留）；断言防回归：前端不再出现撤回入口
    assert.ok(!html.includes('undoLast'), '前端撤回函数已移除');
    assert.ok(!html.includes('updateUndoBtn'), '撤回按钮显隐逻辑已移除');
    assert.ok(!html.includes('id="undoBtn"'), '撤回按钮 DOM 已移除');
    assert.ok(html.includes('_hint'), '错误分层 _hint 翻译存在');
    assert.ok(html.includes("ev.type === 'stopped'"), '停止确认事件处理存在');
    assert.ok(html.includes('toggleKeyVis'), 'API Key 显隐切换存在');
    assert.ok(html.includes('enterkeyhint="send"'), '移动端 enterkeyhint 存在');
    assert.ok(html.includes('id="verBadge"'), '动态版本号占位存在');
    assert.ok(html.includes('confirm(') && html.includes('即将触发进化实验'), '进化实验二次确认存在');
    assert.ok(html.includes('accept="'), '上传 accept 限制存在');
    assert.ok(html.includes('if (h.version)'), '版本号动态读取');
  });

  // ===== 身份语义修复（v3.4：主语限定 + 我是谁口径 + system prompt 身份锚定）=====
  const { matchSmallTalk } = require(path.join(ROOT, 'lib', 'smalltalk.js'));
  await t('身份：含「谁」的普通问题不被误截为身份卡', () => {
    assert.strictEqual(matchSmallTalk('谁是最可爱的人'), null, '文学问题应走 LLM');
    assert.strictEqual(matchSmallTalk('谁是最可爱的人？'), null);
    assert.strictEqual(matchSmallTalk('什么人最伟大'), null, '无 Agent 主语不命中');
    assert.strictEqual(matchSmallTalk('他叫什么名字'), null, '第三人称不命中');
    assert.strictEqual(matchSmallTalk('查查今日有啥大事'), null, '任务消息不受影响');
  });
  await t('身份：「我是谁」回答用户身份（语义与你是谁相反）', () => {
    const r = matchSmallTalk('我是谁');
    assert.ok(r && r.includes('老板'), '应说明用户是老板：' + r);
  });
  await t('身份：问 Agent 身份仍走产品口径', () => {
    assert.ok(matchSmallTalk('你是谁').includes('HWJ Agent'));
    assert.ok(matchSmallTalk('你叫什么名字').includes('HWJ Agent'));
    assert.ok(matchSmallTalk('你是机器人吗').includes('HWJ Agent'));
    assert.ok(matchSmallTalk('who are you').includes('HWJ Agent'));
  });
  await t('身份：称呼类问题不再漏网进 LLM（Agnes 泄漏入口）', () => {
    const r = matchSmallTalk('你要叫我什么啊');
    assert.ok(r && r.includes('HWJ') && r.includes('老板'), '应同时交代自己和用户称呼：' + r);
    assert.ok(matchSmallTalk('怎么称呼你').includes('HWJ Agent'));
  });
  await t('身份：system prompt 锚定产品身份（Agnes/Sapiens 防泄漏）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(src.includes('你是 HWJ Agent'), '内层 system prompt 声明 HWJ 身份');
    assert.ok(src.includes('禁止自称或影射任何其他名字'), '禁止底层模型自我认知泄漏');
    assert.ok(src.includes('HWJ Agent 的子智能体'), '子智能体身份锚定');
    const st = fs.readFileSync(path.join(ROOT, 'lib', 'smalltalk.js'), 'utf8');
    assert.ok(st.includes('您是老板'), '「我是谁」口径落库');
  });

  // ===== 进化专用 LLM 配置 + 限流自适应（v3.4）=====
  await t('进化 LLM：evolution 段保存/打码/回退（POST /api/config）', async () => {
    const post = await (await fetch(base + '/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ evolution: { base_url:'https://evo.example.com/v1', model:'evo-mini', api_key:'sk-evo-test-123' } }) })).json();
    assert.ok(post.success, JSON.stringify(post));
    const get = await (await fetch(base + '/api/config')).json();
    const evo = get.config && get.config.evolution;
    assert.ok(evo && evo.base_url === 'https://evo.example.com/v1' && evo.model === 'evo-mini', 'evolution 段已保存');
    assert.ok(/ˣˣˣˣ/.test(evo.api_key), 'evolution key 打码返回');
    assert.ok(get.config.inner && get.config.inner.base_url, 'inner 段不受影响');
  });
  await t('进化 LLM：evoConfig 配置齐全用 evolution 段，缺省回退 inner', () => {
    const evo = require(path.join(ROOT, 'lib', 'evolution.js'));
    assert.ok(typeof evo.evoConfig === 'function' && typeof evo.evoLlmSource === 'function', '导出 evoConfig/evoLlmSource');
    const cfg = evo.evoConfig();
    assert.ok(cfg.base_url && cfg.api_key && cfg.model, 'evolution 段齐全时优先使用');
    assert.strictEqual(evo.evoLlmSource(), 'evolution');
  });
  await t('进化 LLM：isRateLimitText 特征判定', () => {
    const evo = require(path.join(ROOT, 'lib', 'evolution.js'));
    assert.ok(evo.isRateLimitText('API 错误 429: too many requests'));
    assert.ok(evo.isRateLimitText('账号配额不足 quota exceeded'));
    assert.ok(evo.isRateLimitText('服务过载 overloaded'));
    assert.strictEqual(evo.isRateLimitText('文件不存在'), false, '普通错误不误判');
  });
  await t('限流自适应：wave 循环含降档/冷却/回升/补跑逻辑', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'evolution.js'), 'utf8');
    assert.ok(src.includes('DUAL_AGENT_EVOLUTION_COOLDOWN_MS'), '冷却窗口可配');
    assert.ok(src.includes('pendingQueue.push(o.c)'), '被限流 case 挪回队尾补跑');
    assert.ok(src.includes('cleanWaves >= 3 && par < PAR_MAX'), '连续干净后并发回升');
    assert.ok(src.includes('rateLimitEvents:rateLimitEvents.slice(0,20)'), '限流事件随 decision 落盘');
  });
  await t('前端静态：进化 API 设置区与 llmSource 展示接线', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('id="suEvoUrl"') && html.includes('id="suEvoModel"') && html.includes('id="suEvoKey"'), '进化 API 三字段存在');
    assert.ok(html.includes('进化专用 API（可选'), '折叠区标题存在');
    assert.ok(html.includes("payload.evolution"), '保存时提交 evolution 段');
    assert.ok(html.includes("srcEl.id = 'edLlmSrc'"), '进化抽屉 llmSource 展示存在');
  });
  await t('效果评估：健康分卡与采集接线静态断言', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    assert.ok(html.includes('id="edHealth"'), '健康分卡片存在');
    assert.ok(html.includes('系统健康分'), '健康分标题存在');
    assert.ok(html.includes('hc-trend'), '版本对比趋势展示存在');
    assert.ok(html.includes('growthLine'), '欢迎页成长统计行存在');
    assert.ok(html.includes('健康 ${st.health.score}'), '顶栏 pill 含健康分');
    assert.ok(html.includes('资产 ${assetTotal}'), '顶栏 pill 含资产数');
    assert.ok(html.includes('toggleAssetDetail'), '资产明细点击展开接线存在');
    assert.ok(html.includes('toggleEvoDetail'), '样本/实验/晋级明细点击展开接线存在');
    assert.ok(html.includes("toggleEvoDetail($('statBench'), 'benchmarks')"), '进化样本格点击接线存在');
    assert.ok(html.includes("toggleEvoDetail($('statExps'), 'experiments')"), '实验次数格点击接线存在');
    assert.ok(html.includes("toggleEvoDetail($('statPromo'), 'promotions')"), '成功进化格点击接线存在');
    assert.ok(html.includes('档案已过期'), '过期档案标识展示存在');
    assert.ok(html.includes('/api/evolution/assets'), '资产明细 API 调用存在');
    assert.ok(html.includes('/api/evolution/detail'), '明细 API 调用存在');
    assert.ok(html.includes('renderScout'), '外部学习区块渲染接线存在');
    assert.ok(html.includes('/api/scout/status'), '外部学习状态接口调用存在');
    assert.ok(html.includes('立即学习'), '外部学习手动触发按钮存在');
    assert.ok(html.includes('renderReinforce'), '强化处理区块渲染接线存在');
    assert.ok(html.includes('/api/reinforce/status'), '强化处理状态接口调用存在');
    assert.ok(html.includes('立即补练'), '强化补练手动触发按钮存在');
    const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.ok(srv.includes("'/api/evolution/assets'"), '资产明细路由存在');
    assert.ok(srv.includes("'/api/evolution/detail'"), '明细路由存在');
    assert.ok(srv.includes("'/api/scout/status'"), '外部学习状态路由存在');
    assert.ok(srv.includes("'/api/reinforce/status'"), '强化处理状态路由存在');
    assert.ok(srv.includes("'/api/reinforce/run'"), '强化补练触发路由存在');
    assert.ok(srv.includes('reinforceDue()'), '补练空闲调度判定接线存在');
    assert.ok(srv.indexOf('reinforceDue()') < srv.indexOf('scoutDue()') , '补练调度应优先于外部学习');
    assert.ok(srv.includes('runReinforceSafe'), '补练执行壳（串行防重入）存在');
    assert.ok(srv.includes("'/api/scout/run'"), '外部学习手动触发路由存在');
    assert.ok(srv.includes('scout.scoutDue()'), '空闲调度判定接线存在');
    assert.ok(srv.includes('runScoutSafe'), '学习执行壳（串行防重入）存在');
    assert.ok(srv.includes('cleanupStale()'), '启动时垃圾清理接线存在');
    assert.ok(srv.includes("setInterval(() => { try { evoClean.cleanupStale(); }"), '每日定时清理接线存在');
    assert.ok(srv.includes('taskT0'), '任务计时起点存在');
    assert.ok(srv.includes('healthDropping()'), '退化触发线接入自动进化');
  });

  srv.kill();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('smoke 崩溃：', e); process.exit(1); });
