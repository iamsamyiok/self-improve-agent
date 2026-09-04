// Node 12 兼容层（闪崩根治）——nodejs-mobile v0.3.3 内置 Node 12.19（官方停更）。
// 工程代码按 Node 18+ 编写，直接跑会 ReferenceError/TypeError → node 线程退出 →
// JNI abort → App 闪崩。install() 在 require server 之前调用，幂等可重复安装。
'use strict';
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

function install() {
  const g = globalThis;


  // fs.rmSync（Node 14.14+）：文件 unlink / 目录 rmdirSync recursive（12.10+ 支持）
  if (!fs.rmSync) {
    fs.rmSync = function (p, opts) {
      try { fs.unlinkSync(p); } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EISDIR' || e.code === 'ENOTEMPTY') {
          fs.rmdirSync(p, { recursive: true, maxRetries: (opts && opts.maxRetries) || 0 });
        } else if (e.code !== 'ENOENT' || !(opts && opts.force)) { throw e; }
      }
    };
  }

  // fs.cpSync（Node 16.7+）：递归复制目录/文件
  if (!fs.cpSync) {
    fs.cpSync = function (src, dest, opts) {
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const name of fs.readdirSync(src)) {
          const s = path.join(src, name), d = path.join(dest, name);
          if (opts && typeof opts.filter === 'function' && !opts.filter(s, d)) continue;
          fs.cpSync(s, d, opts);
        }
      } else {
        fs.copyFileSync(src, dest);
      }
    };
  }

  // AbortController（Node 15+）：最小实现——signal.aborted / reason / 事件监听
  if (!g.AbortController) {
    g.AbortSignal = class {
      constructor() { this.aborted = false; this.reason = undefined; this._ls = []; }
      addEventListener(type, fn) { if (type === 'abort') this._ls.push(fn); }
      removeEventListener(type, fn) { this._ls = this._ls.filter(f => f !== fn); }
      _fire() { this._ls.slice().forEach(fn => { try { fn(); } catch (e) {} }); }
    };
    g.AbortController = class {
      constructor() { this.signal = new g.AbortSignal(); }
      abort(reason) {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this.signal.reason = reason || new Error('The operation was aborted');
        this.signal._fire();
      }
    };
  }

  // fetch（Node 18+ 全局）：覆盖工程全部用法——JSON 请求 + SSE 流式 body.getReader()
  // resp 契约：ok/status/statusText/headers.get/body.getReader()/text()/json()
  if (!g.fetch) {
    g.fetch = function (url, opts) {
      opts = opts || {};
      return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(String(url)); } catch (e) { return reject(new TypeError('Invalid URL: ' + url)); }
        const mod = u.protocol === 'http:' ? http : https;
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new TypeError('Unsupported protocol: ' + u.protocol));
        const headers = Object.assign({}, opts.headers || {});
        const req = mod.request({
          hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search, method: opts.method || 'GET', headers
        }, (res) => {
          const h = { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v || null); } };
          // 单源流队列：data 事件只注册一次，getReader/text/json 共享同一队列。
          // reader 与 text/json 二选一使用（工程内互斥：SSE 走 reader，其余走 text/json）
          const q = { buf: [], waiters: [], endWaiters: [], ended: false, error: null };
          res.on('data', (c) => {
            const v = { done: false, value: new Uint8Array(c) };
            if (q.waiters.length) { const w = q.waiters.shift(); w(v); } else q.buf.push(v);
          });
          const finish = (err) => {
            q.ended = true; q.error = err || null;
            while (q.waiters.length) q.waiters.shift()(err ? Promise.reject(err) : { done: true, value: undefined });
            while (q.endWaiters.length) q.endWaiters.shift()(err ? Promise.reject(err) : undefined);
          };
          res.on('end', () => finish(null));
          res.on('error', (e) => finish(e));
          const nextChunk = () => new Promise((res2, rej2) => {
            if (q.buf.length) return res2(q.buf.shift());
            if (q.ended) return q.error ? rej2(q.error) : res2({ done: true, value: undefined });
            q.waiters.push(res2);
          });
          const allBuf = () => new Promise((res2, rej2) => {
            const collect = () => {
              if (q.error) return rej2(q.error);
              if (q.ended) return res2(Buffer.concat(q.buf.splice(0).map(v => Buffer.from(v.value))));
              q.endWaiters.push(() => collect());
            };
            collect();
          });
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: h,
            body: { getReader: () => ({ read: nextChunk }) },
            text: () => allBuf().then(b => b.toString('utf8')),
            json: () => allBuf().then(b => JSON.parse(b.toString('utf8')))
          });
        });
        req.on('error', reject);
        if (opts.timeout) { req.setTimeout(Number(opts.timeout), () => req.destroy(new Error('fetch timeout'))); }
        if (opts.signal) {
          if (opts.signal.aborted) { req.destroy(); return reject(opts.signal.reason || new Error('The operation was aborted')); }
          opts.signal.addEventListener('abort', () => req.destroy(opts.signal.reason || new Error('The operation was aborted')));
        }
        if (opts.body != null) req.write(opts.body);
        req.end();
      });
    };
  }
}

module.exports = { install };
