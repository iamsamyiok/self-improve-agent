// lib/experience.js 单测：后端选择、降级链、FTS 检索质量、写路径钩子、指纹重建
'use strict';
// 隔离数据目录：必须在 require evolution/experience 之前设置（EV_ROOT 启动时定型）
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-test-'));
const DATA = path.join(T, 'data');
fs.mkdirSync(path.join(DATA, 'evolution'), { recursive: true });
process.env.DUAL_AGENT_DATA = DATA;
const { createExperienceStore } = require('../lib/experience');
const evolution = require('../lib/evolution');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } }

// 造经验数据（直接写 source of truth JSONL）
const lessons = [
  { id: 'ls_a1', key: 'k1', task: '修复登录页按钮点击无反应的 bug', lesson: '改前端事件绑定后必须 lintCode 校验语法', createdAt: '2026-01-01' },
  { id: 'ls_a2', key: 'k2', task: '部署网站到服务器后访问 502', lesson: '部署后必须 probe 探活确认端口监听', createdAt: '2026-01-02' },
  { id: 'ls_a3', key: 'k3', task: '编写 CSV 导出功能数据乱码', lesson: '写文件时显式指定 utf8 编码避免中文乱码', createdAt: '2026-01-03' }
];
fs.writeFileSync(path.join(DATA, 'evolution', 'lessons.jsonl'), lessons.map(l => JSON.stringify(l)).join('\n') + '\n');
const playbooks = [
  { id: 'pb_b1', key: 'p1', task: '给网页加一个深色模式切换按钮', steps: 'read,edit,lintCode,verify', ts: '2026-01-04' },
  { id: 'pb_b2', key: 'p2', task: '修复 API 超时导致任务失败', steps: 'fetch,edit,verify', ts: '2026-01-05' }
];
fs.writeFileSync(path.join(DATA, 'evolution', 'playbooks.jsonl'), playbooks.map(p => JSON.stringify(p)).join('\n') + '\n');

// 1. auto 后端：zvec 可用环境选 zvec，并完成首次全量建索引
const store = createExperienceStore({ dataDir: DATA });
console.log('  -- backend = ' + store.backend);
ok(store.backend === 'zvec' || store.backend === 'file', 'auto 模式返回合法后端');
if (store.backend === 'zvec') {
  ok(fs.existsSync(path.join(DATA, 'evolution', 'experience-index', 'build-meta.json')), 'zvec 首次建索引落盘 meta');
}

// 2. 检索质量：相似任务命中对应教训
const hits = store.searchLessons('登录按钮点了没反应怎么办', 3);
ok(Array.isArray(hits) && hits.length >= 1, '检索返回结构合法');
ok(hits.some(l => l.id === 'ls_a1'), '相似任务命中登录 bug 教训（got: ' + hits.map(h => h.id).join(',') + '）');
const hits2 = store.searchLessons('网站打不开返回 502', 3);
ok(hits2.some(l => l.id === 'ls_a2'), '相似任务命中 502 部署教训（got: ' + hits2.map(h => h.id).join(',') + '）');
const hits3 = store.searchLessons('量子纠缠的自旋测量', 3);
ok(!hits3.some(l => l.id === 'ls_a1') && !hits3.some(l => l.id === 'ls_a2'), '无关查询低噪声（got: ' + hits3.map(h => h.id).join(',') + '）');

// 3. kind 过滤：searchPlaybooks 只回 playbook
const pbHits = store.searchPlaybooks('深色模式切换按钮', 2);
ok(pbHits.length >= 1 && pbHits.every(p => String(p.id).startsWith('pb_')), 'searchPlaybooks 只返回 playbook');

// 4. 写路径钩子：注入后 recordLessons/recordPlaybook 同步进索引
evolution.setExperienceStore(store);
const rec = evolution.recordLessons({ task: '修复导出按钮点击后表格空白的问题', gaps: ['表格渲染前必须等数据加载完成再绑定'] });
ok(rec && rec.id, 'recordLessons 正常落盘');
if (store.backend === 'zvec') {
  const after = store.searchLessons('导出按钮表格空白', 3);
  ok(after.some(l => l.id === rec.id), '写路径钩子即时入索引（got: ' + after.map(h => h.id).join(',') + '）');
}

// 5. 未注入 store 时注入函数走内置路径（行为等价旧版）
evolution.setExperienceStore(null);
const secPlain = evolution.lessonsPromptSection('修复登录页按钮点击无反应的 bug', 3);
ok(typeof secPlain === 'string', '未注入时 lessonsPromptSection 返回字符串');
evolution.setExperienceStore(store);
const secZvec = evolution.lessonsPromptSection('修复登录页按钮点击无反应的 bug', 3);
ok(secZvec.includes('相关教训'), '注入后 lessonsPromptSection 输出教训段落');
ok(secZvec.includes('登录'), '注入后命中登录教训内容');

// 6. 强制 file 后端
const fs2 = createExperienceStore({ dataDir: DATA, backend: 'file' });
ok(fs2.backend === 'file', 'backend=file 强制走内置实现');
const fh = fs2.searchLessons('登录页按钮点击无反应', 3);
ok(fh.some(l => l.id === 'ls_a1'), 'file 后端 bigram 检索正常');


// 8. M2：语义检索接口（async 契约）+ mutation prompt 召回段
(async () => {
  const sem = await store.searchLessonsSemantic('部署完网站访问报 502 网关错误', 3);
  ok(Array.isArray(sem) && sem.some(l => l.id === 'ls_a2'), 'semantic 检索命中 502 教训（got: ' + sem.map(h => h.id).join(',') + '）');
  const semFs = await fs2.searchLessonsSemantic('登录页按钮点击无反应', 3);
  ok(Array.isArray(semFs) && semFs.some(l => l.id === 'ls_a1'), 'file 后端 semantic 兑现 async 契约');

  evolution.setExperienceStore(store);
  const section = await evolution.buildSimilarExperienceSection([{ count: 2, representative: '部署后 502 网关错误端口未监听', samples: [] }]);
  ok(section.includes('历史相似经验'), 'mutation prompt 含语义召回段');
  ok(section.includes('502') || section.includes('probe'), '召回段命中部署教训内容');
  const empty = await evolution.buildSimilarExperienceSection([]);
  ok(empty === '', '无失败模式时返回空段');
  evolution.setExperienceStore(null);
  const secNone = await evolution.buildSimilarExperienceSection([{ count: 1, representative: 'x', samples: [] }]);
  ok(secNone === '', '未注入 store 时返回空段（零依赖路径）');

  // 7. 指纹变化触发重建（先 close 旧实例——zvec 写单进程独占，同目录不可双开重建）
  store.close();

  // 8. M3-1：benchmark 语义判重 + rankHardFirst 重复降次
  const b1 = evolution.recordBenchmark({ task: '给用户管理页面增加批量删除功能并带确认弹窗', finalText: '完成', ws: 'default' });
  ok(b1 && !b1.duplicateOf, '首个 benchmark 无判重标记');
  const b2 = evolution.recordBenchmark({ task: '给用户管理页面增加批量删除功能带确认弹窗', finalText: '完成', ws: 'default' });
  ok(b2 && b2.duplicateOf === b1.id, '高相似任务应判重指向首个 case（got: ' + (b2 && b2.duplicateOf) + '）');
  const b3 = evolution.recordBenchmark({ task: '修复数据库连接泄漏导致请求堆积', finalText: '完成', ws: 'default' });
  ok(b3 && !b3.duplicateOf, '不同任务不误判重复');
  const rankedCases = evolution.rankHardFirst([{ id: b1.id, createdAt: '2026-01-01' }, { id: b3.id, createdAt: '2026-01-02' }], null);
  ok(rankedCases[0].id === b3.id, 'duplicate case 选样降次（got: ' + rankedCases.map(c => c.id).join(',') + '）');

  fs.writeFileSync(path.join(DATA, 'evolution', 'lessons.jsonl'), lessons.concat([{ id: 'ls_a4', key: 'k4', task: '数据库连接池耗尽请求排队', lesson: '数据库操作后必须释放连接', createdAt: '2026-01-06' }]).map(l => JSON.stringify(l)).join('\n') + '\n');
  const store2 = createExperienceStore({ dataDir: DATA });
  ok(store2.backend === 'zvec', '指纹变化后重建成功');
  const h4 = store2.searchLessons('数据库连接池耗尽', 3);
  ok(h4.some(l => l.id === 'ls_a4'), '重建后新数据可检索（got: ' + h4.map(h => h.id).join(',') + '）');
  store2.close();
})().then(() => {
  console.log(fail ? `experience smoke: ${fail} failed` : `experience smoke: ok — backend/fallback/fts-quality/hooks/rebuild/semantic (${pass} passed)`);
  process.exit(fail ? 1 : 0);
});
