// Android 壳入口：由 nodejs-mobile 以 "node mobile-main.js <dataDir>" 方式启动
// 数据目录由 Kotlin 侧通过 argv[2] 传入（App 私有目录），所有状态隔离在其中
const path = require('path');
const fs = require('fs');

const dataDir = process.argv[2] || path.join(__dirname, '.mobile-data');
// 注意：不设 DUAL_AGENT_PLUGINS_DIR——插件必须随 nodejs-project/plugins（版本化内置目录）
// 加载。曾把插件目录指向 dataDir/plugins（空目录），导致全部插件加载失败（真机实测踩坑）。
for (const d of [dataDir, path.join(dataDir, 'data'), path.join(dataDir, 'workspaces')]) {
  fs.mkdirSync(d, { recursive: true });
}

process.env.DUAL_AGENT_DATA = path.join(dataDir, 'data');
process.env.DUAL_AGENT_WS_ROOT = path.join(dataDir, 'workspaces');
process.env.DUAL_AGENT_AUTOSTOP = '0';            // App 内生命周期由前台服务管理，禁用空闲自动退出
process.env.DUAL_AGENT_MOBILE = '1';              // bash 插件据此启用 Android 适配层
process.env.DUAL_AGENT_PORT = process.env.DUAL_AGENT_PORT || '3788';
process.env.PORT = process.env.DUAL_AGENT_PORT;
process.env.NODE_NO_WARNINGS = '1';
process.env.TMPDIR = path.join(dataDir, 'tmp');
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

// toybox 环境 PATH：/system/bin 是 Android 标准位置；Termux 存在时优先
const termux = '/data/data/com.termux/files/usr/bin';
process.env.PATH = [termux, '/system/bin', '/system/xbin'].filter(p => fs.existsSync(p)).join(':');

console.log(`[mobile-main] data=${dataDir} port=${process.env.PORT} path=${process.env.PATH}`);
require('./server.js');
