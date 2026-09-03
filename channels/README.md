# Dual-Agent Qwen Code Channels 接入指南

## 概述

本指南说明如何将 dual-agent 系统接入 Qwen Code 的 Channels 功能，实现在飞书、微信、钉钉等平台与双 Agent 交互。

## 架构说明

dual-agent 提供标准 HTTP API（端口 3000），Qwen Code Channels 通过 ACP（Agent Client Protocol）调用该 API。

```
用户发消息 → 飞书/微信/钉钉 → Qwen Code Channel → dual-agent HTTP API → 执行任务 → 返回结果
```

## 前置条件

1. **安装 Qwen Code**
   ```bash
   npm install -g @qwen-code/qwen-code
   ```

2. **启动 dual-agent 服务**
   ```bash
   cd /workspace/dual-agent
   PORT=3000 DUAL_AGENT_AUTOSTOP=0 node server.js
   ```

3. **配置内层 API**
   - 访问 http://localhost:3000
   - 点击右上角「配置」，填写内层 LLM API 信息（base_url、api_key、model）

## 各平台接入步骤

### 飞书（Feishu）

1. **创建飞书应用**
   - 访问 [飞书开放平台](https://open.feishu.cn/)
   - 创建企业自建应用
   - 获取 App ID 和 App Secret

2. **配置权限**
   - 添加机器人能力
   - 授权范围：im:message:receive（接收消息）
   - 可选：im:message:send_as_bot（发送消息）

3. **启用机器人**
   - 在应用详情页启用机器人功能
   - 设置机器人名称和头像

4. **配置 Qwen Code**
   
   编辑 `~/.qwen/settings.json`：
   ```json
   {
     "channels": {
       "feishu-dual": {
         "type": "feishu",
         "clientId": "YOUR_APP_ID",
         "clientSecret": "YOUR_APP_SECRET",
         "senderPolicy": "open",
         "sessionScope": "user",
         "cwd": "/workspace/dual-agent",
         "groupPolicy": "disabled",
         "dmPolicy": "open",
         "instructions": "你是双 Agent 系统的执行助手。使用插件系统完成任务。",
         "blockStreaming": "off"
       }
     }
   }
   ```

5. **启动通道**
   ```bash
   qwen channel start feishu-dual
   ```

6. **测试**
   - 在飞书中搜索机器人名称
   - 发送消息测试

### 钉钉（DingTalk）

1. **创建钉钉应用**
   - 访问 [钉钉开放平台](https://open.dingtalk.com/)
   - 创建企业内部应用
   - 获取 AppKey 和 AppSecret

2. **配置机器人**
   - 启用机器人能力
   - 设置消息接收地址（钉钉支持 webhook）

3. **配置 Qwen Code**
   ```json
   {
     "channels": {
       "dingtalk-dual": {
         "type": "dingtalk",
         "clientId": "$DINGTALK_CLIENT_ID",
         "clientSecret": "$DINGTALK_CLIENT_SECRET",
         "senderPolicy": "open",
         "sessionScope": "user",
         "cwd": "/workspace/dual-agent",
         "groupPolicy": "disabled",
         "dmPolicy": "open",
         "instructions": "你是双 Agent 系统的执行助手。"
       }
     }
   }
   ```

4. **启动通道**
   ```bash
   qwen channel start dingtalk-dual
   ```

### 企业微信（WeCom）

1. **创建企业微信应用**
   - 访问 [企业微信管理后台](https://work.weixin.qq.com/)
   - 创建自建应用
   - 获取 AgentId 和 Secret

2. **配置回调**
   - 设置消息接收 URL
   - 配置加密密钥

3. **配置 Qwen Code**
   ```json
   {
     "channels": {
       "wecom-dual": {
         "type": "wecom",
         "botId": "$WECOM_BOT_ID",
         "secret": "$WECOM_BOT_SECRET",
         "senderPolicy": "open",
         "sessionScope": "user",
         "cwd": "/workspace/dual-agent"
       }
     }
   }
   ```

### 微信（WeChat）

微信个人号对接需要特殊方案：

**方案 A：微信机器人框架**
- 使用 [itchat](https://github.com/littlecodersh/ItChat) 或 [wechaty](https://github.com/wechaty/wechaty)
- 配合双 Agent 使用

**方案 B：微信公众号**
- 创建公众号
- 配置消息回调到 Qwen Code
- 需要备案域名和服务器

**推荐：使用企业微信替代个人微信**

### QQ Bot

1. **申请 QQ 机器人**
   - 访问 [QQ 开放平台](https://q.qq.com/)
   - 创建机器人应用
   - 获取 Token

2. **配置 Qwen Code**
   ```json
   {
     "channels": {
       "qqbot-dual": {
         "type": "qqbot",
         "token": "$QQ_BOT_TOKEN",
         "senderPolicy": "open",
         "cwd": "/workspace/dual-agent"
       }
     }
   }
   ```

## 环境变量配置

建议在启动 Qwen Code 前设置环境变量：

```bash
# dual-agent 服务地址
export DUAL_AGENT_HOST=127.0.0.1
export DUAL_AGENT_PORT=3000

# 各平台密钥（建议使用 .env 文件）
export FEISHU_APP_ID=your_app_id
export FEISHU_APP_SECRET=your_app_secret
export DINGTALK_CLIENT_ID=your_client_id
export DINGTALK_CLIENT_SECRET=your_client_secret
export WECHATY_PUPPET=wechaty-puppet-wechat  # 微信方案
```

## 高级配置

### 发送者策略

- `open`：允许所有用户
- `allowlist`：仅允许白名单用户
- `pairing`：新用户需配对审批

```json
{
  "senderPolicy": "allowlist",
  "allowedUsers": ["user_id_1", "user_id_2"]
}
```

### 会话范围

- `user`：每个用户独立会话
- `chat_thread`：每个群聊/话题独立会话
- `single`：所有用户共享会话

### 群聊策略

```json
{
  "groupPolicy": "open",
  "groups": {
    "*": { "requireMention": true }
  }
}
```

### 消息分发模式

- `steer`：新消息打断当前任务（默认）
- `collect`：消息排队，完成后合并处理
- `followup`：消息排队，逐个处理

### 流式输出

```json
{
  "blockStreaming": "on",
  "blockStreamingChunk": { "minChars": 400, "maxChars": 1000 },
  "blockStreamingCoalesce": { "idleMs": 1500 }
}
```

## 故障排查

### 常见问题

1. **机器人不响应**
   - 检查 Qwen Code 是否启动：`qwen channel status`
   - 检查 dual-agent 服务是否运行：访问 http://localhost:3000
   - 查看日志：`~/.qwen/logs/`

2. **消息发送失败**
   - 检查平台 API 权限
   - 确认 App ID / Secret 正确
   - 验证网络连接

3. **任务执行失败**
   - 检查内层 API 配置
   - 查看 dual-agent 日志：`.data/server.log`
   - 确认工作目录权限

### 日志位置

```bash
# Qwen Code 日志
~/.qwen/logs/

# dual-agent 日志
/workspace/dual-agent/.data/server.log
```

## 开发调试

### 测试本地通道

```bash
# 安装开发版 Qwen Code
npm install -g @qwen-code/qwen-code

# 链接本地适配器
cd /workspace/dual-agent
qwen extensions link ./channels

# 启动测试
qwen channel start --debug
```

### 自定义适配器

如需开发自定义适配器，参考：

```javascript
// channels/custom-adapter.js
const { ChannelBase } = require('@qwen-code/channel-base');

class CustomChannel extends ChannelBase {
  constructor(name, config, bridge, options) {
    super(name, config, bridge, options);
  }
  
  async connect() {
    // 平台连接逻辑
  }
  
  async sendMessage(chatId, text) {
    // 发送消息逻辑
  }
}

module.exports = {
  channelType: 'custom',
  displayName: 'Custom Platform',
  createChannel: (name, config, bridge, options) => 
    new CustomChannel(name, config, bridge, options)
};
```

## 安全建议

1. **使用 pairing 模式**：首次使用时需要管理员审批
2. **设置白名单**：限制可使用的用户
3. **保护 API Key**：使用环境变量，不要硬编码
4. **限制群聊权限**：群聊中要求 @mention 才响应

## 相关链接

- [Qwen Code 官方文档](https://github.com/QwenLM/qwen-code)
- [飞书开放平台](https://open.feishu.cn/)
- [钉钉开放平台](https://open.dingtalk.com/)
- [企业微信管理后台](https://work.weixin.qq.com/)
