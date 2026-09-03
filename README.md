# HWJ Agent — Self-Improving Agent Runtime v3

一个零依赖 Node.js Agent Runtime：**Inner Agent 负责完成用户任务，后台 Meta-Agent 负责寻找改进机会，Evolution Engine 用可重复实验决定改动是否真的值得采用。**

> 核心原则：**修改不是改进，只有经过 Benchmark、Evaluator、Regression Guard 验证的候选版本，才有资格进入生产。**

## 1. 这版解决什么问题

旧式 Agent 的闭环通常是：

```text
任务 → Agent → 工具 → 结果
```

HWJ Agent 进一步形成：

```text
任务
 ↓
执行 Agent
 ↓
Execution / Experience
 ↓
Failure & Bottleneck Mining
 ↓
Meta Agent
 ↓
Improvement Hypothesis
 ↓
Mutation
 ↓
Sandbox Candidate
 ↓
Baseline vs Candidate
 ↓
Evaluation
 ↓
Regression Guard
 ↓
Promote / Reject
 ↓
新版本 Agent
 ↺
```

因此 Agent 不只是“自己改代码”，而是**通过实验选择自己的下一版本能力**。

## 2. 当前能力

### Agent Runtime

- OpenAI-compatible Chat API
- Tool Calling / Plugin Runtime
- Skill 渐进式加载
- 多工作区
- 会话持久化
- Context Compression
- 中断恢复
- 过程审计

### Memory

- 短期记忆
- 长期记忆
- 任务归档
- BM25 / 关键词检索
- Embedding 语义检索
- RRF 混合排序
- 自动 Recall / Archive

### Self-Improvement

- Experience Ledger
- Benchmark Dataset
- Failure Mining
- Improvement Hypothesis
- Candidate Mutation
- 独立 Sandbox Worker
- Baseline / Candidate A/B
- LLM Judge
- Objective Artifact Check
- Process Score
- Paired Benchmark Statistics
- Regression Guard
- Promote / Reject
- Snapshot / Rollback
- Evolution History / Leaderboard

### Web UI

2.2.0 对 Web UI 做了重新整理：

- 桌面端以 Inner Agent 聊天区为主体；🧬 进化史、🧩 插件、⚙ 设置作为独立入口
- 统一间距、边框、按钮和字体层级
- 去除大面积渐变和过重阴影
- 插件列表独立滚动，不挤压聊天区域
- 中间聊天区始终作为视觉主体
- Meta-Agent 在后台运行，用户通过 🧬 进化史查看自我改进
- 弹窗、Diff、设置面板统一视觉语言
- 小屏自动切换为单面板聊天模式
- 保留原有 DOM ID 和 JS API，不破坏已有功能

## 3. 你实际需要怎么用

日常只需要打开 Web UI，与 Inner Agent 对话。系统会自动保存成功任务作为 Benchmark。默认累计 **3 个成功任务**后，后台才会启动第一次进化实验；这是为了避免只凭一两个任务就修改 Agent。以后每次有新的成功任务，系统会继续积累样本并在后台寻找值得验证的改进。

你不需要手动审批 Outer Agent 的每个修改。点击 **🧬 进化史** 可以按时间倒序查看：发生了什么变化、为什么变化、Agent 的假设、实验结果以及是否自动升级。点击 **🧩 插件** 才进入低频插件管理；**⚙ 设置**只处理模型和运行配置。

## 4. 安装

要求 Node.js >= 18。

```bash
npm install
```

项目没有运行时 npm 依赖，主要使用 Node.js 内置模块。

## 5. 启动 Web UI

```bash
npm start
```

然后打开：

```text
http://127.0.0.1:3788/
```

如果端口被占用，可以：

```bash
DUAL_AGENT_PORT=3900 npm start
```

Windows PowerShell：

```powershell
$env:DUAL_AGENT_PORT=3900; npm start
```

## 6. 首次配置

打开 Web UI 后进入「设置」。

### 内层 LLM

填写：

```text
Base URL
API Key
Model
```

接口需要兼容 OpenAI Chat Completions / Responses 所使用的项目接口。

### Embedding（可选）

推荐使用 OpenAI-compatible Embedding API，例如：

```text
Base URL: https://api.siliconflow.cn/v1
Model: BAAI/bge-m3
```

没有 Embedding 时，Memory 会自动降级为关键词检索。

## 7. TUI

```bash
node hwj/hwj.js
```

或：

```bash
node hwj/hwj.js --ws default
```

单次任务：

```bash
node hwj/hwj.js --script "创建 hello.txt 并写入 Hello"
```

安静模式：

```bash
node hwj/hwj.js --script "读取 hello.txt" --quiet
```

## 8. Self-Improving Loop

### Meta-Agent 的两种运行方式

自动进化由后台 Meta-Agent 驱动，按以下优先级运行：

1. **本机 opencode CLI**（可选增强）：检测到 `opencode` 命令时使用（可读文件、上下文更强）
2. **直连 LLM**（默认路径）：未安装 opencode 时，直接使用「设置」中配置的内层 API 生成改进假设——只需一个 OpenAI 兼容 API，自进化闭环即可完整运转

### 自动什么时候开始？

默认开启自动 Evolution，不需要设置环境变量。第一次至少需要 3 个成功 Benchmark：

```text
任务 1 → Benchmark 1
任务 2 → Benchmark 2
任务 3 → Benchmark 3 → 后台启动 Evolution
```

之后 Evolution 会自动执行：

```text
Observe → Diagnose → Hypothesize → Mutate
→ Sandbox → Baseline/Candidate A/B
→ Evaluate → Regression Guard → Promote / Reject
```

如果 Meta-Agent 判断没有足够证据，它可以选择 `none`，本轮不做任何修改。这是正常行为。

### 自动升级

默认开启自动 Promote：只有实验达到统计门槛且没有严重 Regression 才会进入新版本。可以用环境变量关闭：

```bash
DUAL_AGENT_AUTO_PROMOTE=0
```

如需关闭自动进化：

```bash
DUAL_AGENT_AUTO_EVOLVE=0
```

### 手动触发

```bash
hwj-agent evolve
```

手动触发和自动触发使用同一套实验、评分和 Regression Guard。

### 一个真实的进化例子

假设最近多个任务都出现“历史经验没有被充分召回”：

```text
为什么改？
→ Meta-Agent 发现记忆召回可能是瓶颈

改了什么？
→ 尝试调整 memory recall 策略

怎么证明？
→ 用同一批历史 Benchmark 跑 Baseline 和 Candidate

结果怎样？
→ Candidate 平均 +8.4%，胜出 10/12

最后？
→ 通过 Regression Guard，自动升级
```

这些内容都会出现在 Web UI 的 **🧬 进化史** 中。

## 9. Evolution 数据


所有 Evolution 数据集中保存：

```text
.data/evolution/
├── benchmarks/
├── experiments/
├── agents/
├── versions/
├── experience.jsonl
├── leaderboard.json
└── state.json
```

一次实验至少包含：

```text
proposal
baseline
candidate
cases
metrics
evaluation
decision
promotion
```

所以每次进化都是**可追溯、可复盘、可比较、可回滚**的。

## 10. Evaluator

综合评价不依赖单一 LLM 判断：

```text
Final Score
 = Outcome
 + Objective Artifact Check
 + Process Metrics
```

同时对 Baseline / Candidate 使用相同 Benchmark，计算：

- mean delta
- standard deviation
- standard error
- 95% confidence lower bound
- win rate
- regression count

核心原则：

```text
局部提升 ≠ 全局提升
一次成功 ≠ 稳定提升
LLM 说更好 ≠ 实际更好
```

## 11. 安全边界

Self-Improvement 默认不是无限制修改自身。

候选版本在独立 workspace 中运行，经过验证后才能进入生产；生产变更保留 snapshot，可执行 rollback。

对于高风险修改，应继续使用人工 Gate。

## 12. 项目结构

```text
lib/
├── evolution.js          # Self-Improving 主循环
├── evolution-worker.js   # Sandbox 实验 Worker
├── regression.js         # 回归保护
├── inner.js              # 内层执行 Agent
├── outer.js              # 外层 Meta Agent
├── plugins.js            # Plugin Runtime
├── sdk.js                # SDK
└── ...

plugins/                  # Agent Tools
skills/                   # Agent Skills
hwj/                      # TUI
public/                   # Web UI
server.js                 # Web Server
test/                     # Smoke / Memory / Evolution Tests
docs/                     # 设计文档
```

## 13. 开发与验证

语法检查：

```bash
node --check lib/evolution.js
node --check lib/evolution-worker.js
node --check hwj/hwj.js
node --check server.js
```

Evolution Smoke Test：

```bash
node test/evolution-smoke.js
```

Evolution 端到端（内置 mock LLM，验证直连 Meta-Agent + A/B + 自动晋级全链路）：

```bash
node test/evolution-e2e.js
node test/web-evolution-e2e.js
```

完整测试：

```bash
npm test
```

## 14. SDK

```js
const { chat, run, evolve } = require('hwj-agent');

const result = await run({
  message: '创建一个 hello.txt 文件并写入 Hello World'
});

await evolve();
```

## 15. 下一阶段

当前 Evolution 已经能够实验性修改：

```text
Plugin
Prompt
Skill
Strategy
Memory
```

下一阶段建议继续增加：

```text
Tool Selection Policy
Planning Policy
Verification Policy
Retrieval Policy
Automatic Task Curriculum
Cross-version Knowledge Transfer
```

最终目标不是“让 Agent 自己写更多代码”，而是：

> **让 Agent 根据长期任务结果持续发现自己的能力瓶颈，并用可重复实验选择更优策略。**

## License

MIT
