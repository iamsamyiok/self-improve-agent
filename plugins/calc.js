// @name calc
// @desc 确定性计算沙箱（零 token）：JS 表达式/聚合计算，vm 沙箱隔离（无 fs/网络/require），500ms 超时。统计汇总类计算用它，不信任心算
// @essential false
const vm = require('vm');

module.exports = {
  params: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JS 代码（表达式或以 return 结尾的语句块）；可用内置：sum(arr)/avg(arr)/round(x,n)/min/max；data 里的字段直接以变量名访问' },
      data: { type: 'string', description: '可选，计算数据（JSON 字符串），代码中用 data.xxx 访问；也可省略直接算表达式' }
    },
    required: ['code']
  },
  run: async (args, ctx) => {
    const code = String(args.code || '').trim();
    if (!code) throw new Error('code 不能为空');
    if (code.length > 20000) throw new Error('代码过长（上限 20000 字符）');
    // 沙箱禁令：require/fs/process/http 等一律不可见；注入纯函数工具集
    let data = null;
    if (args.data !== undefined && args.data !== null && String(args.data).trim()) {
      try { data = JSON.parse(String(args.data)); } catch (e) { throw new Error(`data 不是合法 JSON：${e.message.slice(0, 120)}`); }
    }
    // 冻结输入防篡改沙箱外对象
    const deepFreeze = (o) => {
      if (o && typeof o === 'object') {
        Object.freeze(o);
        for (const k of Object.keys(o)) deepFreeze(o[k]);
      }
      return o;
    };
    if (data !== null) deepFreeze(data);
    const sandbox = Object.freeze({
      data,
      sum: arr => Array.from(arr).reduce((a, b) => a + Number(b), 0),
      avg: arr => { const v = Array.from(arr).map(Number); return v.reduce((a, b) => a + b, 0) / v.length; },
      round: (x, n = 0) => Number(Number(x).toFixed(Number(n))),
      min: (...a) => Math.min(...a.flat()),
      max: (...a) => Math.max(...a.flat()),
      Math, Number, String, Boolean, Array, Object, JSON,
      parseInt, parseFloat, isNaN, isFinite
    });
    try {
      // 表达式直接求值；含 return/语句特征按语句块跑
      const isExpr = !/\breturn\b|;\s*$|^\s*(const|let|var|if|for|while)\b/.test(code);
      // 语句块包 IIFE：vm.Script 按 script 体执行，顶层 return 非法
      const script = new vm.Script(isExpr ? `(${code})` : `(function(){ ${code} })()`);
      const result = script.runInNewContext(sandbox, { timeout: 500 });
      if (result === undefined) throw new Error('代码无返回值：表达式直接写（如 1+2）；语句块必须以 return 结尾');
      const out = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
      return `计算结果（${isExpr ? '表达式' : '语句块'}）：\n\n${out.length > 4000 ? out.slice(0, 4000) + '\n…（已截断）' : out}`;
    } catch (e) {
      if (e.message && /timed? ?out/i.test(e.message)) throw new Error('计算超时（500ms 上限）：检查是否有死循环');
      throw new Error(`计算失败：${e.message.slice(0, 200)}`);
    }
  }
};
