// 插件静态预检：语法硬拦（vm 编译，不执行代码）+ 危险模式软警告（审批时展示，不阻断）
// 用途：把「批准→热加载 broken→回滚」循环拦在应用之前；危险操作提醒用户看清再批
const vm = require('vm');

// 危险模式清单：命中即在审批栏显示黄色警告（插件本身允许这些能力，但用户应知情）
const DANGER_PATTERNS = [
  { re: /require\s*\(\s*['"]child_process['"]\s*\)/, msg: '可派生子进程（shell 命令）' },
  { re: /require\s*\(\s*['"](net|dgram|dns|tls|http|https)['"]\s*\)/, msg: '可发起网络连接/监听' },
  { re: /process\.(exit|kill|binding)\b/, msg: '可终止/杀死进程' },
  { re: /\.\s*listen\s*\(/, msg: '可监听端口（网络服务）' },
  { re: /rmSync\s*\([^)]*recursive/, msg: '可递归删除目录' },
  { re: /(unlink|rm|rmdir)Sync\s*\(\s*['"]\/(etc|usr|bin|windows|system32)/i, msg: '可删除系统路径文件' },
  { re: /require\s*\(\s*['"]fs['"]\s*\)[\s\S]{0,80}(write|append)FileSync?\s*\(\s*['"]\/(etc|usr|bin|windows|system32)/i, msg: '可写入系统路径' },
  { re: /eval\s*\(|new\s+Function\s*\(/, msg: '使用动态代码执行（eval/new Function）' }
];

// 返回 { syntax: '', warns: [] }；syntax 非空 = 语法错误（应拒绝应用）
function lintCode(code) {
  const src = String(code || '');
  if (!src.trim()) return { syntax: '代码为空', warns: [] };
  let syntax = '';
  try {
    // 仅编译不执行：CommonJS body 编译为 Script 即可发现语法错误
    new vm.Script(src, { filename: 'plugin.js' });
  } catch (e) {
    syntax = String((e && e.message) || e);
  }
  const warns = [];
  for (const p of DANGER_PATTERNS) {
    if (p.re.test(src)) warns.push(p.msg);
  }
  return { syntax, warns };
}

module.exports = { lintCode, DANGER_PATTERNS };
