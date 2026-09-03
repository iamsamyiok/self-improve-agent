// @name verify
// @desc 产出验证（框架判定 pass/fail）：exists/contains/not_contains/regex/line_count/max_lines/json_valid/json_path 多规则一次断言
// @essential false
const fs = require('fs');
const path = require('path');

// 病根（v0.9.4）：验证靠模型 read 回看自评——既耗 token（read 全文）又不可靠（模型看了也说对）。
// 本插件把「验证」变成框架判定：规则不满足返回明确 FAIL，模型看到失败自会修，形成闭环。
// 多规则一次调用：复杂任务 N 项产出断言一轮完成，省轮次省 token。

module.exports = {
  params: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径（必填，相对当前工作区）' },
      rules: {
        type: 'array',
        description: '断言规则列表（至少 1 条）',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['exists', 'contains', 'not_contains', 'regex', 'line_count', 'max_lines', 'json_valid', 'json_path'], description: '规则类型' },
            text: { type: 'string', description: 'contains/not_contents 时必填：文本' },
            pattern: { type: 'string', description: 'regex 时必填：正则（无 flags）' },
            exact: { type: 'number', description: 'line_count 时可选：精确行数' },
            min: { type: 'number', description: 'line_count 时可选：最少行数' },
            max: { type: 'number', description: 'max_lines 时必填 / line_count 可选：行数上限' },
            expr: { type: 'string', description: 'json_path 时必填：点路径（如 a.b.0.c）' },
            equals: { description: 'json_path 时可选：断言值（缺省仅断言路径存在）' }
          },
          required: ['type']
        }
      }
    },
    required: ['path', 'rules']
  },

  run: async (args, ctx) => {
    // P0 修复：路径标准化（v0.9.25）
    // 处理三种输入形态：
    //   1) 相对路径 'sub/file.md'        → 直接使用
    //   2) 带 cwd 前缀 '/abs/ws/file'    → 剥前缀
    //   3) 绝对路径 '/file'（不属 cwd）  → 转相对；若 resolve 后仍越界则拒绝
    let userPath = String(args.path || '');
    if (ctx.cwd && userPath.startsWith(ctx.cwd)) {
      userPath = userPath.slice(ctx.cwd.length);
      if (userPath.startsWith('/') || userPath.startsWith('\\')) {
        userPath = userPath.slice(1);
      }
    } else if (path.isAbsolute(userPath) && ctx.cwd) {
      // 绝对路径但不在 cwd 内：尝试转相对路径
      const rel = path.relative(ctx.cwd, userPath);
      if (!rel.startsWith('..') && rel.length > 0) {
        userPath = rel;
      }
    }
    const fp = path.resolve(ctx.cwd, userPath);
    if (!fp.startsWith(ctx.cwd + path.sep) && fp !== ctx.cwd) {
      throw new Error(`路径越界：${args.path}（resolve 后 ${fp} 不在工作区内）`);
    }
    const rules = Array.isArray(args.rules) ? args.rules : [];
    if (!rules.length) throw new Error('rules 为空（至少提供 1 条断言规则）');

    const rel = path.relative(ctx.cwd, fp) || fp;
    const exists = fs.existsSync(fp);
    const lines = [];

    // 读一次文件（exists 后），失败降级为空内容让各规则自行判定
    let content = '';
    if (exists) {
      try { content = fs.readFileSync(fp, 'utf8'); } catch (e) { content = ''; }
    }

    const fileLines = content.split('\n');
    // 末尾换行产生的空尾元素不计入行数（wc -l 口径）
    const lineCount = content.length ? (content.endsWith('\n') ? fileLines.length - 1 : fileLines.length) : 0;

    // json_path 求值：点路径逐级下钻（数组下标数字）
    const getByPath = (obj, expr) => {
      let cur = obj;
      for (const k of String(expr).split('.').filter(Boolean)) {
        if (cur === null || cur === undefined) return undefined;
        const key = /^\d+$/.test(k) ? Number(k) : k;
        cur = cur[key];
      }
      return cur;
    };

    let pass = 0;
    let idx = 0;
    for (const r of rules) {
      idx += 1;
      const label = `#${idx} ${r.type}`;
      let ok = false;
      let detail = '';
      try {
        switch (r.type) {
          case 'exists':
            ok = exists;
            detail = exists ? '文件存在' : '文件不存在';
            break;
          case 'contains':
            ok = exists && content.includes(String(r.text ?? ''));
            detail = `应包含 ${JSON.stringify(String(r.text ?? '').slice(0, 60))}`;
            break;
          case 'not_contains':
            ok = !exists || !content.includes(String(r.text ?? ''));
            detail = `不应包含 ${JSON.stringify(String(r.text ?? '').slice(0, 60))}`;
            break;
          case 'regex': {
            if (!r.pattern) { detail = 'pattern 缺失'; break; }
            // m flag：^ $ 按行锚定（grep 直觉）。实测教训：模型写 ^34$ 表达"末行为 34"，
            // 不带 m 时是整串锚点 → 误报 FAIL → 模型被迫退回人肉 read，验证器失信
            const re = new RegExp(String(r.pattern), 'm');
            ok = exists && re.test(content);
            const m = exists ? content.match(re) : null;
            detail = m ? `匹配片段 ${JSON.stringify(m[0].slice(0, 60))}` : `未匹配 /${r.pattern}/`;
            break;
          }
          case 'line_count': {
            if (!exists) { detail = '文件不存在'; break; }
            if (r.exact !== undefined) { ok = lineCount === r.exact; detail = `要求 =${r.exact}，实际 ${lineCount}`; }
            else if (r.min !== undefined || r.max !== undefined) {
              const lo = r.min !== undefined ? lineCount >= r.min : true;
              const hi = r.max !== undefined ? lineCount <= r.max : true;
              ok = lo && hi;
              detail = `要求 [${r.min ?? 0}, ${r.max ?? '∞'}]，实际 ${lineCount}`;
            } else { detail = 'exact/min/max 至少一个'; }
            break;
          }
          case 'max_lines':
            ok = exists && lineCount <= Number(r.max);
            detail = `上限 ${r.max}，实际 ${lineCount}`;
            break;
          case 'json_valid': {
            if (!exists) { detail = '文件不存在'; break; }
            try { JSON.parse(content); ok = true; detail = 'JSON 合法'; }
            catch (e) { detail = `JSON 非法：${e.message.slice(0, 80)}`; }
            break;
          }
          case 'json_path': {
            if (!exists) { detail = '文件不存在'; break; }
            if (!r.expr) { detail = 'expr 缺失'; break; }
            let root;
            try { root = JSON.parse(content); }
            catch (e) { detail = `JSON 非法：${e.message.slice(0, 60)}`; break; }
            const v = getByPath(root, r.expr);
            if (v === undefined) { detail = `路径 ${r.expr} 不存在`; break; }
            if (r.equals !== undefined) {
              const want = typeof r.equals === 'string' ? r.equals : JSON.stringify(r.equals);
              const got = typeof v === 'string' ? v : JSON.stringify(v);
              ok = want === got;
              detail = `${r.expr} = ${got.slice(0, 60)}${ok ? '' : `（期望 ${want.slice(0, 60)}）`}`;
            } else { ok = true; detail = `${r.expr} = ${JSON.stringify(v).slice(0, 60)}`; }
            break;
          }
          default:
            detail = `未知规则类型 ${r.type}`;
        }
      } catch (e) {
        detail = `规则执行出错：${String(e.message || e).slice(0, 80)}`;
      }
      if (ok) pass += 1;
      lines.push(`${ok ? '✓' : '✗'} ${label}：${detail}`);
    }

    const verdict = pass === rules.length ? 'PASS' : 'FAIL';
    return `验证 ${rel}：${pass}/${rules.length} 通过 → ${verdict}\n${lines.join('\n')}`;
  }
};
