// hwj-agent — 双层 Agent 自迭代系统 SDK 入口
// 快速上手：
//   const { chat, run } = require('hwj-agent');
//   const answer = await chat({ baseUrl, apiKey, model, message: '一句话解释 RRF' });
//   const r = await run({ message: '创建 hello.txt 写入问候语' });  // r.finalText
module.exports = require('./lib/sdk');
