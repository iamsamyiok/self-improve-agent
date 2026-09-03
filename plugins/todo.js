// @name todo
// @desc 任务清单跨轮追踪：add 添加 / list 列出 / toggle 勾选完成 / clear 清理（存当前工作区 .todo.json）
// @essential false
const fs = require('fs');
const path = require('path');

function todoFile(ctx) { return path.join(ctx.cwd, '.todo.json'); }

function load(ctx) {
  try {
    const d = JSON.parse(fs.readFileSync(todoFile(ctx), 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function store(ctx, arr) {
  fs.mkdirSync(path.dirname(todoFile(ctx)), { recursive: true });
  fs.writeFileSync(todoFile(ctx), JSON.stringify(arr, null, 1), 'utf8');
}

function fmt(arr) {
  if (!arr.length) return '（清单为空）';
  return arr.map(t => `${t.done ? '[x]' : '[ ]'} #${t.id} ${t.text}`).join('\n');
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'toggle', 'clear'], description: '操作：add 添加 / list 列出 / toggle 勾选 / clear 清理' },
      text: { type: 'string', description: 'add 时必填：任务描述（参数名必须是 text，不能写成 content）' },
      id: { type: 'number', description: 'toggle 时必填：任务 id' },
      mode: { type: 'string', enum: ['done', 'all'], description: 'clear 可选：done 只清已完成（默认），all 清空' }
    },
    required: ['action']
  },
  run: async (args, ctx) => {
    const arr = load(ctx);
    if (args.action === 'add') {
      const text = String(args.text || args.content || '').trim(); // 兼容 content 别名（模型常用）
      if (!text) throw new Error('text 为空（任务描述请放在 text 参数里）');
      const item = { id: (arr.length ? arr[arr.length - 1].id : 0) + 1, text: text.slice(0, 300), done: false };
      arr.push(item);
      store(ctx, arr);
      return `已添加 #${item.id}：${item.text}\n${fmt(arr)}`;
    }
    if (args.action === 'list') return `共 ${arr.length} 项（未完成 ${arr.filter(t => !t.done).length} 项）：\n${fmt(arr)}`;
    if (args.action === 'toggle') {
      const id = Number(args.id);
      const t = arr.find(x => x.id === id);
      if (!t) throw new Error(`#${id} 不存在`);
      t.done = !t.done;
      store(ctx, arr);
      return `#${id} 已标记为${t.done ? '完成' : '未完成'}\n${fmt(arr)}`;
    }
    if (args.action === 'clear') {
      if (args.mode === 'all') { store(ctx, []); return '已清空任务清单'; }
      const left = arr.filter(t => !t.done);
      store(ctx, left);
      return `已清理 ${arr.length - left.length} 项已完成任务，剩 ${left.length} 项`;
    }
    throw new Error(`未知操作：${args.action}（支持 add/list/toggle/clear）`);
  }
};
