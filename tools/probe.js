// 端口探测小工具（启动脚本用，零依赖；node >= 18）
// 用法：
//   node tools/probe.js <port> free   → exit 0 = 端口空闲；1 = 被占用
//   node tools/probe.js <port> ours   → exit 0 = 本程序已在该端口运行；1 = 其他程序/无响应
//   node tools/probe.js <port> ready  → 同 ours（就绪探测）
const net = require('net');
const [, , portArg, mode] = process.argv;
const port = Number(portArg) || 3788;

function isFree() {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(true));
    setTimeout(() => { try { s.destroy(); } catch {} resolve(false); }, 3000);
  });
}

async function isOurs() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    const t = await r.text();
    return /"success"\s*:\s*true/.test(t) && /"version"/.test(t); // health 独有字段，防误认他人服务
  } catch { return false; }
}

(async () => {
  if (mode === 'free') process.exit((await isFree()) ? 0 : 1);
  process.exit((await isOurs()) ? 0 : 1);
})();
