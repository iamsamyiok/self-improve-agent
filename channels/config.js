// Dual-Agent Channel Configuration Templates
// Copy relevant sections to ~/.qwen/settings.json

module.exports = {
  // Feishu Channel Configuration
  feishu: {
    type: 'feishu',
    clientId: '$FEISHU_APP_ID',
    clientSecret: '$FEISHU_APP_SECRET',
    senderPolicy: 'open',
    sessionScope: 'user',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    instructions: `你是双 Agent 系统的执行助手。你的工作目录是：${process.cwd()}
请使用双 Agent 插件系统完成任务，包括：
- read: 读取文件内容
- edit: 修改文件
- write: 创建文件
- bash: 执行命令
- search: 搜索代码
- calc: 计算数学表达式
- stat: 查询文件信息
- verify: 验证产出文件
- probe: 诊断工具
- query: 数据查询
- diff: 文件对比
- tree: 目录树
- archive: 归档压缩
- memory: 记忆存储
- skill: 技能管理
- todo: 任务清单
- usage: token 用量查询
- intent: 意图管理
- subagent: 子智能体派生
- fetch: 网络请求`,
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // WeChat (Weixin) Channel Configuration
  weixin: {
    type: 'weixin',
    senderPolicy: 'open',
    sessionScope: 'user',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    instructions: '同上',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // DingTalk Channel Configuration
  dingtalk: {
    type: 'dingtalk',
    clientId: '$DINGTALK_CLIENT_ID',
    clientSecret: '$DINGTALK_CLIENT_SECRET',
    senderPolicy: 'open',
    sessionScope: 'user',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    instructions: '同上',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // WeCom (Enterprise WeChat) Channel Configuration
  wecom: {
    type: 'wecom',
    botId: '$WECOM_BOT_ID',
    secret: '$WECOM_BOT_SECRET',
    senderPolicy: 'open',
    sessionScope: 'user',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    instructions: '同上',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // QQ Bot Channel Configuration
  qqbot: {
    type: 'qqbot',
    token: '$QQ_BOT_TOKEN',
    senderPolicy: 'open',
    sessionScope: 'user',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    instructions: '同上',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // Telegram Channel Configuration
  telegram: {
    type: 'telegram',
    token: '$TELEGRAM_BOT_TOKEN',
    senderPolicy: 'open',
    sessionScope: 'user',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    dmPolicy: 'open',
    instructions: 'You are a dual-agent execution assistant. Use the plugin system to complete tasks.',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // GitHub Channel Configuration
  github: {
    type: 'github',
    token: '$GITHUB_TOKEN',
    senderPolicy: 'open',
    sessionScope: 'chat_thread',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    reasonFilter: ['mention', 'review_requested', 'assign'],
    instructions: 'You are a dual-agent execution assistant for GitHub. Respond to @mentions and review requests.',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  },

  // GitLab Channel Configuration
  gitlab: {
    type: 'gitlab',
    token: '$GITLAB_TOKEN',
    senderPolicy: 'open',
    sessionScope: 'chat_thread',
    cwd: '/path/to/your/dual-agent-project',
    groupPolicy: 'disabled',
    instructions: 'You are a dual-agent execution assistant for GitLab. Respond to issues and merge requests.',
    blockStreaming: 'off',
    dispatchMode: 'steer'
  }
};
