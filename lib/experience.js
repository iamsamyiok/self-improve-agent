// ---------- ExperienceStore：经验检索层（zvec 融合） ----------
// 统一接口 + 双实现 + 自动降级：
//   ZvecStore —— @zvec/zvec 进程内向量库（FTS/BM25 + ngram 中文分词），仅服务器端可用
//   FileStore —— 内置纯 JS 降级（复用 evolution.js 的 bigram 相似度扫描），Node 12 兼容，
//                行为与本模块引入前的 lessonsPromptSection/playbooksPromptSection 完全一致
// 隔离原则：@zvec/zvec 只允许在本文件动态 require；移动端/无 bindings 环境自动走 FileStore。
// 数据原则：lessons.jsonl/playbooks.jsonl 永远是 source of truth，zvec 集合是可随时重建的
//           派生索引；任何 zvec 异常都不上抛主流程（search 失败回退 FileStore 路径）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha16(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn('[experience] ' + msg);
}

// 数据源指纹：lessons/playbooks 文件的体积+修改时间。变化即触发索引重建。
function fingerprint(files) {
  return files.map(function (f) {
    try {
      const st = fs.statSync(f);
      return path.basename(f) + ':' + st.size + ':' + st.mtimeMs;
    } catch (e) { return path.basename(f) + ':none'; }
  }).join('|');
}

// Node 12 兼容删除目录树：14.14+ 用 rmSync，旧版回退 rmdirSync recursive
function removeTree(dir) {
  try {
    if (fs.rmSync) fs.rmSync(dir, { recursive: true, force: true });
    else fs.rmdirSync(dir, { recursive: true });
  } catch (e) { /* 目录不存在 */ }
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

// ---------- FileStore：零依赖降级实现（延迟 require 防循环依赖） ----------
function createFileStore() {
  return {
    backend: 'file',
    searchLessons: function (taskText, k) {
      const evo = require('./evolution');
      return evo.listRelevantLessons(taskText, k);
    },
    searchPlaybooks: function (taskText, k) {
      const evo = require('./evolution');
      return evo.listRelevantPlaybooks(taskText, k);
    },
    // 语义检索统一入口：FileStore 无向量通道，直接以 bigram 结果兑现 async 契约
    searchLessonsSemantic: function (taskText, k) {
      const evo = require('./evolution');
      return Promise.resolve(evo.listRelevantLessons(taskText, k));
    },
    searchPlaybooksSemantic: function (taskText, k) {
      const evo = require('./evolution');
      return Promise.resolve(evo.listRelevantPlaybooks(taskText, k));
    },
    indexLesson: function () {},
    indexPlaybook: function () {},
    close: function () {}
  };
}

// ---------- embedding 通道（可选，config.json 的 embedding 段齐全才启用） ----------
// { "embedding": { "base_url": "https://.../v1", "api_key": "...", "model": "text-embedding-..." } }
// OpenAI 兼容 /embeddings 接口；未配置/调用失败一律降级纯 FTS，绝不阻塞主流程。
function readEmbeddingCfg(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    const e = cfg && cfg.embedding;
    if (e && e.base_url && e.model && e.api_key) return { base_url: String(e.base_url), api_key: String(e.api_key), model: String(e.model) };
  } catch (e) { /* 无配置文件视为未启用 */ }
  return null;
}

let vecDisabled = false;
function embedTexts(embCfg, texts) {
  const url = String(embCfg.base_url).replace(/\/+$/, '') + '/embeddings';
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(function () { ac.abort(); }, 30000) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + embCfg.api_key },
    body: JSON.stringify({ model: embCfg.model, input: texts }),
    signal: ac ? ac.signal : undefined
  }).then(function (resp) {
    if (timer) clearTimeout(timer);
    if (!resp.ok) throw new Error('embeddings HTTP ' + resp.status);
    return resp.json();
  }).then(function (j) {
    const out = j && j.data;
    if (!Array.isArray(out) || out.length !== texts.length) throw new Error('embeddings 响应结构异常');
    return out.map(function (d) { return d.embedding; });
  }).catch(function (e) {
    if (timer) clearTimeout(timer);
    throw e;
  });
}

// query embedding 缓存（P2-6）：相同任务文本 60s 内不重复调 API（进化初次/重试路径、
// 同任务多轮召回场景）；只缓存单条查询，初始化/回填批量调用不用
const _qEmbCache = new Map(); // key -> { ts, vec }，Node 12 兼容写法
function embedQueryCached(embCfg, text) {
  const key = String(text);
  const hit = _qEmbCache.get(key);
  if (hit && Date.now() - hit.ts < 60000) return Promise.resolve([hit.vec]);
  return embedTexts(embCfg, [key]).then(function (arr) {
    _qEmbCache.set(key, { ts: Date.now(), vec: arr[0] });
    if (_qEmbCache.size > 20) _qEmbCache.delete(_qEmbCache.keys().next().value);
    return [arr[0]];
  });
}

// RRF（倒数排名融合）：两路排序列表合并，k=60 为标准常数
function rrfMerge(listA, listB, k) {
  const score = {};
  const byId = {};
  for (const list of [listA, listB]) {
    list.forEach(function (doc, i) {
      const id = doc && doc.id;
      if (!id) return;
      score[id] = (score[id] || 0) + 1 / (60 + i + 1);
      byId[id] = doc;
    });
  }
  return Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }).slice(0, k).map(function (id) { return byId[id]; });
}

// ---------- ZvecStore：FTS(BM25+ngram) 实现 ----------
// 集合 schema：text(FTS ngram 2-3) + kind(lesson/playbook) + payload(原对象 JSON)
// 启动时按指纹对账：指纹变化或索引缺失 → 全量重建（数据量 ≤ 数百条，毫秒级）
function createZvecStore(opts) {
  // 拼接路径防止移动端静态打包器（webpack/metro 等）把原生模块解析进产物；
  // 真实运行时（服务器 Node）正常加载，打包环境/无 bindings 时此处抛错 → 上层降级
  const zvec = require('@zvec' + '/zvec');
  const evDir = path.join(opts.dataDir, 'evolution');
  const idxDir = path.join(evDir, 'experience-index');
  const benchDir = path.join(evDir, 'benchmarks');
  const sources = [path.join(evDir, 'lessons.jsonl'), path.join(evDir, 'playbooks.jsonl')];
  const metaFile = path.join(idxDir, 'build-meta.json');
  // 指纹含 benchmark 池：case 增删同样触发索引重建
  const fp = fingerprint(sources) + '|' + fingerprintBenchmarks(benchDir);

  // benchmark 池指纹：case 文件名+修改时间串（量大时截断最新 200 个）
  function fingerprintBenchmarks(dir) {
    try {
      return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json'); }).sort().slice(-200)
        .map(function (f) {
          try { const st = fs.statSync(path.join(dir, f)); return f + ':' + st.mtimeMs; } catch (e) { return f + ':gone'; }
        }).join(',');
    } catch (e) { return 'none'; }
  }

  function readBenchmarks(dir) {
    try {
      return fs.readdirSync(dir).filter(function (f) { return f.endsWith('.json'); }).slice(-200).map(function (f) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (c && c.id && c.task) return c;
        } catch (e) { /* 跳过坏文件 */ }
        return null;
      }).filter(Boolean);
    } catch (e) { return []; }
  }

  function buildSchema() {
    return new zvec.ZVecCollectionSchema({
      name: 'experience',
      fields: [
        {
          name: 'text',
          dataType: zvec.ZVecDataType.STRING,
          indexParams: {
            indexType: zvec.ZVecIndexType.FTS,
            tokenizerName: 'ngram',
            extraParams: JSON.stringify({ ngram_min: 2, ngram_max: 3 })
          }
        },
        { name: 'kind', dataType: zvec.ZVecDataType.STRING },
        { name: 'payload', dataType: zvec.ZVecDataType.STRING }
      ]
    });
  }

  function openOrRebuild() {
    // 指纹一致 → 直接重开已有索引
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta && meta.fingerprint === fp) {
        const c = zvec.ZVecOpen(idxDir);
        return { col: c, fresh: false };
      }
    } catch (e) { /* 无 meta / 打不开 / 指纹变化 → 重建 */ }
    // 清目录重建（索引是派生数据，删除重建即对账）
    removeTree(idxDir);
    const col = zvec.ZVecCreateAndOpen(idxDir, buildSchema());
    const lessons = readJsonl(sources[0]);
    const playbooks = readJsonl(sources[1]);
    const docs = [];
    for (const l of lessons) {
      if (!l || !l.id) continue;
      docs.push({ id: 'ls-' + l.id, fields: { text: String(l.task || '') + ' ' + String(l.lesson || ''), kind: 'lesson', payload: JSON.stringify(l) } });
    }
    for (const p of playbooks) {
      if (!p || !p.id) continue;
      docs.push({ id: 'pb-' + p.id, fields: { text: String(p.task || '') + ' ' + String(p.steps || ''), kind: 'playbook', payload: JSON.stringify(p) } });
    }
    // benchmark 池入索引（kind=benchmark）：供新 case 语义判重
    for (const b of readBenchmarks(benchDir)) {
      docs.push({ id: 'bm-' + b.id, fields: { text: String(b.task || '').slice(0, 2000), kind: 'benchmark', payload: JSON.stringify({ id: b.id, task: b.task, hard: !!b.hard }) } });
    }
    if (docs.length) col.upsertSync(docs);
    try { fs.mkdirSync(idxDir, { recursive: true }); } catch (e) { /* 已存在 */ }
    fs.writeFileSync(metaFile, JSON.stringify({ fingerprint: fp, builtAt: new Date().toISOString(), docs: docs.length }), 'utf8');
    return { col: col, fresh: true };
  }

  const opened = openOrRebuild();
  const col = opened.col;

  function query(kind, taskText, k) {
    const q = String(taskText || '').trim();
    if (!q) return [];
    const hits = col.querySync({
      fieldName: 'text',
      fts: { matchString: q.slice(0, 500) },
      topk: Math.max(1, k | 0) + 2, // 多取几个，filter 后截断
      filter: "kind = '" + kind + "'"
    });
    const out = [];
    for (const h of hits) {
      try { out.push(JSON.parse(h.fields.payload)); } catch (e) { continue; }
      if (out.length >= Math.max(1, k | 0)) break;
    }
    return out;
  }

  // ---------- 向量旁路（lazy，独立集合，失败静默降级纯 FTS） ----------
  const embCfg = readEmbeddingCfg(opts.dataDir);
  const vecDir = path.join(evDir, 'experience-vec');
  let vecCol = null;
  let vecInitPromise = null;

  function vecSchema(dim) {
    return new zvec.ZVecCollectionSchema({
      name: 'experience_vec',
      fields: [
        { name: 'kind', dataType: zvec.ZVecDataType.STRING },
        { name: 'payload', dataType: zvec.ZVecDataType.STRING }
      ],
      vectors: [{
        name: 'emb',
        dataType: zvec.ZVecDataType.VECTOR_FP32,
        dimension: dim,
        indexParams: { indexType: zvec.ZVecIndexType.HNSW, metricType: zvec.ZVecMetricType.COSINE }
      }]
    });
  }

  function vecDocs() {
    const docs = [];
    for (const l of readJsonl(sources[0])) {
      if (!l || !l.id) continue;
      docs.push({ id: 'ls-' + l.id, text: String(l.task || '') + ' ' + String(l.lesson || ''), kind: 'lesson', payload: JSON.stringify(l) });
    }
    for (const p of readJsonl(sources[1])) {
      if (!p || !p.id) continue;
      docs.push({ id: 'pb-' + p.id, text: String(p.task || '') + ' ' + String(p.steps || ''), kind: 'playbook', payload: JSON.stringify(p) });
    }
    return docs;
  }

  // 首次语义检索时异步建向量集合（embedding 探测维度 → 全量入库）；失败后本进程内不再重试
  function ensureVecCol() {
    if (!embCfg || vecDisabled) return Promise.resolve(null);
    if (vecCol) return Promise.resolve(vecCol);
    if (vecInitPromise) return vecInitPromise;
    vecInitPromise = (async function () {
      const docs = vecDocs();
      if (!docs.length) return null;
      const probe = await embedTexts(embCfg, ['dim-probe']);
      const dim = probe[0].length;
      removeTree(vecDir);
      const c = zvec.ZVecCreateAndOpen(vecDir, vecSchema(dim));
      const batch = docs.map(function (d) {
        return d._p = embedTexts(embCfg, [d.text]).then(function (vec) {
          return { id: d.id, fields: { kind: d.kind, payload: d.payload }, vectors: { emb: vec[0] } };
        }).catch(function () { return null; });
      });
      const settled = await Promise.all(batch);
      const rows = settled.filter(Boolean);
      if (rows.length) c.upsertSync(rows);
      vecCol = c;
      return c;
    })().catch(function (e) {
      vecDisabled = true;
      warnOnce('embedding 通道不可用，语义检索降级纯 FTS: ' + ((e && e.message) || e));
      return null;
    });
    return vecInitPromise;
  }

  function vecQuery(kind, taskText, k) {
    return ensureVecCol().then(function (c) {
      if (!c) return [];
      return embedQueryCached(embCfg, String(taskText || '').slice(0, 500)).then(function (vec) {
        const hits = c.querySync({ fieldName: 'emb', vector: vec[0], topk: Math.max(1, k | 0) + 2, filter: "kind = '" + kind + "'" });
        const out = [];
        for (const h of hits) {
          try { out.push(JSON.parse(h.fields.payload)); } catch (e) { continue; }
          if (out.length >= Math.max(1, k | 0)) break;
        }
        return out;
      });
    }).catch(function () { return []; });
  }

  // 语义检索 = FTS + 向量两路 RRF 融合（async；进化引擎异步链路专用）。
  // 任一路失败自动退化——向量路失败 → 纯 FTS；FTS 失败 → 内置 bigram 扫描。
  function searchSemantic(kind, taskText, k, fileFallback) {
    const n = Math.max(1, k | 0);
    const ftsList = query(kind, taskText, n);
    return vecQuery(kind, taskText, n).then(function (vecList) {
      const merged = vecList.length ? rrfMerge(ftsList, vecList, n) : ftsList;
      if (merged.length) return merged;
      return fileFallback(taskText, n);
    }).catch(function () {
      return ftsList.length ? ftsList : fileFallback(taskText, n);
    });
  }

  function indexDoc(prefix, kind, obj, textField) {
    if (!obj || !obj.id) return;
    const text = textField(obj);
    const payload = JSON.stringify(obj);
    try {
      col.upsertSync([{ id: prefix + obj.id, fields: { text: text, kind: kind, payload: payload } }]);
    } catch (e) { warnOnce(prefix + ' 索引更新失败（启动时将自动重建）: ' + (e && e.message)); }
    // 向量旁路增量入库（fire-and-forget；失败静默，下次全量重建兜底）
    if (embCfg && !vecDisabled && vecCol) {
      embedTexts(embCfg, [text]).then(function (vec) {
        try { vecCol.upsertSync([{ id: prefix + obj.id, fields: { kind: kind, payload: payload }, vectors: { emb: vec[0] } }]); } catch (e) { /* 重建兜底 */ }
      }).catch(function () { /* 重建兜底 */ });
    }
  }

  return {
    backend: 'zvec',
    fresh: opened.fresh,
    searchLessons: function (taskText, k) {
      try { return query('lesson', taskText, k); }
      catch (e) { warnOnce('zvec 查询失败，本次降级文件检索: ' + (e && e.message)); return createFileStore().searchLessons(taskText, k); }
    },
    searchPlaybooks: function (taskText, k) {
      try { return query('playbook', taskText, k); }
      catch (e) { warnOnce('zvec 查询失败，本次降级文件检索: ' + (e && e.message)); return createFileStore().searchPlaybooks(taskText, k); }
    },
    searchLessonsSemantic: function (taskText, k) {
      return searchSemantic('lesson', taskText, k, function (t, n) { return createFileStore().searchLessons(t, n); });
    },
    searchPlaybooksSemantic: function (taskText, k) {
      return searchSemantic('playbook', taskText, k, function (t, n) { return createFileStore().searchPlaybooks(t, n); });
    },
    // benchmark 语义判重：返回 [{id, task, hard}]，供 recordBenchmark 标记 duplicateOf
    findSimilarBenchmarks: function (taskText, k) {
      try {
        const hits = col.querySync({
          fieldName: 'text',
          fts: { matchString: String(taskText || '').slice(0, 2000) },
          topk: Math.max(1, k | 0),
          filter: "kind = 'benchmark'"
        });
        const out = [];
        for (const h of hits) {
          try { out.push(JSON.parse(h.fields.payload)); } catch (e) { continue; }
        }
        return out;
      } catch (e) { return null; } // null = 检索不可用，调用方走 bigram 兜底
    },
    // 写路径增量钩子：source of truth 落盘后同步 upsert 索引（失败静默，启动对账兜底）
    indexLesson: function (lesson) { indexDoc('ls-', 'lesson', lesson, function (l) { return String(l.task || '') + ' ' + String(l.lesson || ''); }); },
    indexPlaybook: function (pb) { indexDoc('pb-', 'playbook', pb, function (p) { return String(p.task || '') + ' ' + String(p.steps || ''); }); },
    // benchmark 入索引（判重数据源）：新 case 落盘后立即入库，后续相似任务才能被检出
    indexBenchmark: function (b) {
      if (!b || !b.id || !b.task) return;
      try {
        col.upsertSync([{ id: 'bm-' + b.id, fields: { text: String(b.task).slice(0, 2000), kind: 'benchmark', payload: JSON.stringify({ id: b.id, task: b.task, hard: !!b.hard }) } }]);
      } catch (e) { warnOnce('benchmark 索引更新失败: ' + (e && e.message)); }
    },
    close: function () { try { col.closeSync(); } catch (e) { /* 进程退出即释放 */ } }
  };
}

// ---------- 工厂：backend 自动选择 + 全链路降级 ----------
// opts.backend: 'auto'（默认，zvec 可用即用）| 'file'（强制内置）| 'zvec'（强制，失败抛错）
function createExperienceStore(opts) {
  const o = opts || {};
  const backend = String(o.backend || process.env.DUAL_AGENT_EXPERIENCE_BACKEND || 'auto').toLowerCase();
  if (backend === 'file') return createFileStore();
  if (backend === 'zvec') return createZvecStore(o);
  // auto
  try {
    const s = createZvecStore(o);
    if (!warned) console.log('[experience] 检索后端: zvec(FTS/ngram)' + (s.fresh ? '（已重建索引）' : ''));
    return s;
  } catch (e) {
    warnOnce('zvec 不可用（' + ((e && e.message) || e) + '），使用内置文件检索');
    return createFileStore();
  }
}

module.exports = { createExperienceStore };
