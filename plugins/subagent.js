// @name subagent
// @desc 子智能体并行调研：派生独立上下文的子任务（读文件/搜索/联网查证），只回结论——保护主上下文不膨胀
// @essential false
// 机制（对标 Claude Code Task 工具）：子任务在独立 messages 里跑完整工具循环（8 轮上限），
// 探索过程的 token 消耗与中间结果全部隔离在子上下文，主上下文只收到压缩后的结论。
// 主上下文因此可以承载更多有效轮次，长任务的「上下文膨胀 → 预算折叠 → 信息丢失」链条被切断。
// 子级禁止再派生（深度 1，防递归爆炸）；tasks 数组内部 Promise.all 并行执行。

module.exports = {
  params: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: '子任务列表（1-4 个，相互独立可并行）。每个子任务必须自带完整上下文：目标、涉及文件路径、输出要求',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: '子任务完整指令（自包含：目标+路径+输出格式）' },
            writable: { type: 'boolean', description: '默认 false 只读探索。true 允许该子任务写文件（write/edit）——仅用于目标文件互不相同的独立产出型子任务，且描述必须写明目标路径' }
          },
          required: ['description']
        }
      }
    },
    required: ['tasks']
  },

  run: async (args, ctx) => {
    if (typeof ctx.spawnSub !== 'function') {
      throw new Error('当前环境禁止派生子智能体（子级不可嵌套派生；此插件仅主会话可用）');
    }
    const tasks = (Array.isArray(args.tasks) ? args.tasks : [])
      .filter(t => t && String(t.description || '').trim())
      .slice(0, 4);
    if (!tasks.length) throw new Error('tasks 为空（每个子任务需要 description）');

    const t0 = Date.now();
    const settled = await Promise.allSettled(tasks.map(t => ctx.spawnSub(String(t.description), !!(t && t.writable))));
    const lines = [];
    let okCount = 0;
    settled.forEach((r, i) => {
      const head = `## 子任务 ${i + 1}：${String(tasks[i].description).slice(0, 60)}`;
      if (r.status === 'fulfilled' && r.value && !/^插件.*(加载失败|执行出错)/.test(String(r.value))) {
        okCount += 1;
        lines.push(`${head}\n${String(r.value).slice(0, 1200)}`);
      } else {
        const raw = r.status === 'rejected' ? String(r.reason && r.reason.message || r.reason) : String(r.value).slice(0, 200);
        // 限流/网络类失败（含 failover 后仍失败）给主会话可操作建议，而非只报错
        const isTransient = /rate.?limit|too many|429|quota|overload|限流|频率|ECONNRESET|ETIMEDOUT|fetch failed/i.test(raw);
        const advice = isTransient
          ? '\n[失败-限流/网络] 该路 API 持续限流（已自动退避重试并尝试换路）。建议：稍后重试此子任务，或缩小并发（一次派 1-2 个），或由主会话直接执行该调研。'
          : '';
        lines.push(`${head}\n[失败] ${raw}${advice}`);
      }
    });
    return `子智能体完成 ${okCount}/${tasks.length}（并行 ${tasks.length} 路，总耗时 ${Math.round((Date.now() - t0) / 1000)}s，结论已压缩，探索细节不占主上下文）：\n\n${lines.join('\n\n')}`;
  }
};
