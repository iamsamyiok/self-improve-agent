// Qwen Code Channel Wrapper for Dual-Agent
// This script sets up the dual-agent as a Qwen Code channel
// Run: node channels/setup.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const QWEN_HOME = process.env.QWEN_HOME || path.join(HOME, '.qwen');
const SETTINGS_PATH = path.join(QWEN_HOME, 'settings.json');

// Get current directory
const projectDir = process.cwd();
console.log(`Project directory: ${projectDir}`);

// Check if Qwen Code is installed
function checkQwenInstalled() {
  try {
    const version = execSync('qwen --version', { encoding: 'utf8' }).trim();
    console.log(`Qwen Code version: ${version}`);
    return true;
  } catch (err) {
    console.error('Qwen Code not found. Install with: npm install -g @qwen-code/qwen-code');
    return false;
  }
}

// Read existing settings
function readSettings() {
  try {
    const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return { channels: {} };
  }
}

// Add dual-agent channel configuration（保留为可复用工具函数：交互式向导或外部脚本可调用）
function addChannel(settings, platform, config) {
  if (!settings.channels) settings.channels = {};
  const channelName = `${platform}-dual`;
  settings.channels[channelName] = {
    type: platform,
    cwd: projectDir,
    senderPolicy: 'open',
    sessionScope: 'user',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    blockStreaming: 'off',
    dispatchMode: 'steer',
    instructions: `你是双 Agent 系统的执行助手。工作目录：${projectDir}

使用插件系统完成任务：
- read: 读取文件
- edit: 修改文件
- write: 创建文件
- bash: 执行命令
- search: 搜索代码
- calc: 计算
- stat: 文件信息
- verify: 验证产出
- probe: 诊断
- query: 查询
- diff: 对比
- tree: 目录树
- archive: 归档
- memory: 记忆
- skill: 技能
- todo: 任务清单
- usage: token 用量
- intent: 意图管理
- subagent: 子智能体`,
    ...config
  };
  console.log(`Channel "${channelName}" configured for ${platform}`);
}

module.exports = { addChannel, SETTINGS_PATH };

// Main setup
function main() {
  console.log('\n=== Dual-Agent Qwen Code Setup ===\n');
  
  // Check Qwen Code installation
  if (!checkQwenInstalled()) {
    process.exit(1);
  }
  
  // Read existing settings
  const settings = readSettings();
  
  // Display configuration options
  console.log('\nConfigured channels:');
  for (const [name, config] of Object.entries(settings.channels || {})) {
    console.log(`  - ${name}: ${config.type} (cwd: ${config.cwd})`);
  }
  
  console.log('\nNext steps:');
  console.log('1. Set platform credentials as environment variables:');
  console.log('   export FEISHU_APP_ID=your_app_id');
  console.log('   export FEISHU_APP_SECRET=your_app_secret');
  console.log('   export DINGTALK_CLIENT_ID=your_client_id');
  console.log('   export DINGTALK_CLIENT_SECRET=your_client_secret');
  console.log('');
  console.log('2. Add channel to ~/.qwen/settings.json (see channels/settings.example.json)');
  console.log('');
  console.log('3. Start dual-agent:');
  console.log('   PORT=3000 DUAL_AGENT_AUTOSTOP=0 node server.js');
  console.log('');
  console.log('4. Start channel:');
  console.log('   qwen channel start <channel-name>');
  console.log('');
  console.log('See channels/README.md for detailed setup instructions.');
}

if (require.main === module) main();
