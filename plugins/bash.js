// @name bash
// @desc 执行 shell 命令并返回输出（默认在工作目录执行，限时 30 秒；Android 上自动适配 toybox 环境）
// @essential true
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- Android（toybox）适配层：DUAL_AGENT_MOBILE=1 时启用，桌面端零影响 ----
const MOBILE = process.env.DUAL_AGENT_MOBILE === '1';
let mobileShell;           // undefined=未探测 / null=探测失败 / string=可用 shell 路径
let mobileTools = null;    // 可用命令清单（缓存到数据目录）

// GNU coreutils → Android toybox 的常见差异重写（逐条尝试，命中才替换）
const MOBILE_REWRITE = [
  [/\bgrep\s+-\w*P/g, 'grep -E'],                    // toybox grep 无 -P（PCRE）
  [/\bsed\s+-i\b(?!\s*-E)/g, 'sed -i.bak'],          // 部分 toybox sed -i 语法差异，备份式最稳
  [/\b(du|df|ls|grep|less)\s+--color(=\w+)?\b/g, '$1'],
  [/\bstat\s+-c\b/g, 'stat -f'],                     // toybox 用 -f（BSD 风格字段）
  [/\bhead\s+-n\s+(\d+)\b/g, 'head -$1'],            // 两种都支持，但老 toybox 只认 -N
  [/\btail\s+-n\s+(\d+)\b/g, 'tail -$1'],
];

function detectMobileShell() {
  if (!MOBILE) return null;
  if (mobileShell !== undefined) return mobileShell;
  for (const sh of ['/system/bin/sh', '/data/data/com.termux/files/usr/bin/bash', '/system/xbin/sh']) {
    try { fs.accessSync(sh, fs.constants.X_OK); mobileShell = sh; return sh; } catch { /* 试下一个 */ }
  }
  mobileShell = null; // 显式缓存失败，避免重复探测
  return null;
}

// 探测 toybox 可用命令（一次性，缓存到 DUAL_AGENT_DATA/mobile-capability.json）
function detectMobileTools() {
  if (!MOBILE || mobileTools) return mobileTools;
  const cache = path.join(process.env.DUAL_AGENT_DATA || '.data', 'mobile-capability.json');
  try {
    mobileTools = JSON.parse(fs.readFileSync(cache, 'utf8'));
    return mobileTools;
  } catch { /* 无缓存则现场探测 */ }
  const known = ['ls','cat','echo','grep','sed','awk','head','tail','wc','find','mkdir','rm','cp','mv','touch','tr','cut','sort','uniq','which','stat','du','df','file','tar','gzip','gunzip','date','sleep','env','printf','test','true','false','sha256sum','md5sum','basename','dirname','readlink','ln','chmod','chown','id','ps','kill','xxd','od','diff','patch','curl','wget','ping','toybox'];
  const avail = [], missing = [];
  const sh = detectMobileShell();
  for (const c of known) {
    let ok = false;
    try {
      require('child_process').execSync(`command -v ${c} >/dev/null 2>&1`, { timeout: 3000, stdio: 'ignore', shell: sh || undefined });
      ok = true;
    } catch { ok = false; }
    (ok ? avail : missing).push(c);
  }
  mobileTools = { shell: sh, avail, missing, probedAt: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, JSON.stringify(mobileTools, null, 2)); } catch { /* 缓存失败不阻断 */ }
  return mobileTools;
}

// 生成给模型的自纠提示：缺什么 + 常见替代
function mobileHint(badOutput) {
  const t = detectMobileTools();
  const miss = (t && t.missing && t.missing.length) ? t.missing.join(', ') : '';
  const tips = [];
  if (/not found|not executable|No such file or directory/i.test(badOutput || '')) {
    tips.push('当前是 Android 环境（toybox 工具集），部分桌面命令不存在。');
    if (miss) tips.push(`不可用命令：${miss}。`);
    tips.push('替代建议：文本处理优先用 read/write 插件与 node 内置能力；grep 用 -E（无 -P）；xxd 可用 od -x；find 支持 -name/-type 基础用法。');
    tips.push(`可用命令：${(t && t.avail || []).join(', ')}。`);
  }
  return tips.join('\n');
}

function rewriteForMobile(cmd) {
  let out = cmd;
  for (const [re, to] of MOBILE_REWRITE) out = out.replace(re, to);
  return out;
}

module.exports = {
  params: {
    type: 'object',
    properties: {
      command: { 
        type: 'string', 
        description: '要执行的 shell 命令（支持 && 串联；避免路径穿越与危险操作）'
      },
      timeout: { 
        type: 'number', 
        description: '可选：覆盖默认 30 秒超时（毫秒）'
      }
    },
    required: ['command']
  },
  run: async (args, ctx) => {
    const cmd = String(args.command || '');
    // 安全预检：拒绝明确危险的操作
    const dangerPatterns = [
      /rm\s+-[a-zA-Z]*[rR][fF]\s+\//,  // rm -rf /
      /\bsudo\b/,                        // sudo 命令
      /\b(shutdown|reboot|poweroff)\b/  // 系统电源操作
    ];
    for (const p of dangerPatterns) {
      if (p.test(cmd)) {
        throw new Error(`命令被拒绝：包含危险操作 "${p.source}"`);
      }
    }
    
    let runCmd = cmd;
    // Windows 控制台默认 GBK 编码，中文输出会乱码：先切 UTF-8 代码页再执行
    if (process.platform === 'win32') runCmd = 'chcp 65001 >nul & ' + runCmd;
    // Android：重写 GNU 风格参数为 toybox 兼容形式
    if (MOBILE) runCmd = rewriteForMobile(runCmd);
    
    const timeout = Number(args.timeout) || 30000;
    const execOpts = {
      cwd: ctx.cwd,
      timeout: timeout,
      maxBuffer: 512 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
      encoding: 'utf8'
    };
    // Android 无 /bin/sh：必须显式指定探测到的 shell
    const sh = detectMobileShell();
    if (sh) execOpts.shell = sh;
    
    return await new Promise((resolve) => {
      exec(runCmd, execOpts, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const errOut = String(stderr || '').trim();
        const combined = out + (out && errOut ? '\n' : '') + errOut;
        const tail = combined.slice(-6000);
        // Android：命令缺失时附上能力提示让模型自纠（换行拼接，可被插件清洗逻辑保留）
        const hint = MOBILE ? mobileHint(combined) : '';
        const withHint = (s) => hint ? `${s}\n[Android 环境提示] ${hint}` : s;
        if (err && err.killed) resolve(withHint(`命令超时被终止（${timeout/1000} 秒）。部分输出：\n${tail}`));
        else if (err && err.code === 127) resolve(withHint(`命令未找到（127）。输出：\n${tail || '（无输出）'}`));
        else if (err) resolve(withHint(`命令退出码 ${err.code == null ? '?' : err.code}。输出：\n${tail || '（无输出）'}`));
        // 重定向无输出命令：返回确认提示
        else if (!tail && /(>>|>|tee)\s+\S+/.test(cmd)) {
          resolve(withHint(`命令执行成功（退出码 0），无终端输出（内容可能已重定向到文件）。如需确认追加/写入是否生效：wc -c <文件> 或 ls -l <文件>`));
        } else resolve(withHint(`命令执行成功（退出码 0）。输出：\n${tail || '（无输出）'}`));
      });
    });
  }
};
