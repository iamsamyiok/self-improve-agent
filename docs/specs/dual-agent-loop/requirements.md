# Requirements Document — 双层 Agent 自迭代系统（dual-agent-loop）

## Introduction

轻量 demo：内层 Agent（OpenAI 兼容 API + 插件执行）+ 外层 Agent（本机 opencode CLI）自闭环。
外层根据内层运行日志与插件状态提出插件增删改建议（结构化 JSON），经用户审批后由服务端
应用修改、生成快照、热加载插件，无需重启内层。全程软约束（系统提示词）+ 审批硬门禁。

## Glossary

- **内层 Agent（Inner）**: 通过 OpenAI 兼容 API 驱动的执行体，以 function calling 调用插件完成任务
- **外层 Agent（Outer）**: 本机 opencode CLI 子进程，读取内层日志与插件状态，产出插件修改建议
- **插件（Plugin）**: plugins/ 目录下的单个 js 文件，导出 { name, desc, essential, params, run }
- **基础插件**: read / write / edit / bash 四个无特权插件，与业务插件同权限、同修改流程
- **热插拔**: 修改审批通过后清除 require 缓存重新加载，内层运行时无感知
- **渐进式加载**: 启动仅加载 essential 插件代码；业务插件仅在清单注册元信息，首次调用时才加载代码
- **审批项（Proposal）**: 外层输出的结构化修改建议 {action, plugin, code, reason}
- **快照（Snapshot）**: 应用任何修改前对受影响插件文件的完整备份，仅保留最近 2 个版本
- **单向同步**: 仅内层日志与插件状态作为上下文注入外层；内层不感知外层存在

## Requirements

### REQ-1 插件管理

**User Story:** AS 用户，I want 在左侧插件管理区查看/新增/编辑/删除插件，SO THAT 掌控内层能力集。

#### Acceptance Criteria

1. WHEN 服务启动，系统 SHALL 扫描 plugins/ 目录并在左侧显示全部插件（基础/业务分组、加载状态）。
2. WHEN 用户手动新增/编辑/删除插件，系统 SHALL 操作前自动生成快照，操作后热加载生效。
3. WHEN 插件代码加载失败，系统 SHALL 在插件列表标记「损坏」并显示错误信息，内层其余插件不受影响。

### REQ-2 内层 Agent 执行

**User Story:** AS 用户，I want 与内层 Agent 对话让其用插件干活，SO THAT 验证插件能力闭环。

#### Acceptance Criteria

1. WHEN 用户发送消息且内层配置有效，系统 SHALL 通过 OpenAI 兼容 API（tools=插件清单）驱动工具调用循环并流式返回。
2. WHILE 内层执行中，系统 SHALL 锁定输入框并实时显示每次插件调用记录（插件名/入参/结果摘要/耗时）。
3. WHEN 内层 LLM API 未配置或调用失败，系统 SHALL 明确报错并提示配置方法。
4. WHEN 插件执行抛出异常，系统 SHALL 将错误信息回传给 LLM 继续循环（不中断整个会话）。

### REQ-3 外层建议生成

**User Story:** AS 用户，I want 外层 OpenCode 分析内层运行情况并提出插件修改建议，SO THAT 系统自我迭代。

#### Acceptance Criteria

1. WHEN 用户在外层发送消息，系统 SHALL 自动注入上下文（插件清单 + 内层最近插件调用日志）后调用 opencode CLI。
2. WHEN 外层回复包含结构化建议（```json 代码块：{action, plugin, code, reason}），系统 SHALL 解析为待审批项并在底部审批栏展示。
3. WHEN 本机未检测到 opencode，系统 SHALL 明确报错并给出安装指引。
4. WHILE 组装外层上下文，系统 SHALL 仅包含日志与插件状态，不包含内层对话全文（上下文隔离）。

### REQ-4 审批与快照

**User Story:** AS 用户，I want 审批每一项修改并可回滚，SO THAT 掌握自迭代的最终控制权。

#### Acceptance Criteria

1. WHEN 审批项产生，系统 SHALL 在底部审批栏展示操作类型/插件名/理由/代码 diff（create=全文，update=前后对比，delete=待删内容）。
2. WHEN 用户批准修改，系统 SHALL 先写入快照再应用修改，随后热加载并记录审计日志。
3. WHEN 用户否决修改，系统 SHALL 丢弃建议且不产生任何文件变更。
4. WHEN 用户点击回滚，系统 SHALL 从最近快照恢复受影响文件并热加载；快照目录仅保留最近 2 个版本。

### REQ-5 软约束

**User Story:** AS 开发者，I want 用系统提示词而非硬编码路径限制约束外层行为，SO THAT demo 结构极简。

#### Acceptance Criteria

1. WHEN 外层会话建立，系统 SHALL 注入系统提示词：仅修改插件目录、不碰核心 runtime、修改必须以结构化 JSON 输出并等待用户批准。
2. WHILE 系统运行，代码中 SHALL 不存在路径白名单校验逻辑（服务端仅按审批结果机械应用）。

### REQ-6 配置

#### Acceptance Criteria

1. WHEN 用户在配置页填写内层 API（base_url/api_key/model）并保存，系统 SHALL 持久化到本地配置文件且密钥仅存本机。
2. WHEN 服务启动，系统 SHALL 自动检测本机 opencode CLI 并在界面显示状态。

### REQ-7 非功能

1. 系统 SHALL 以零 npm 依赖运行（node server.js 即启动）。
2. 所有插件修改（手动或审批）SHALL 记录审计日志（时间/来源/操作/结果）。

## Decisions（已与用户确认）

- 外层引擎：本机 opencode CLI
- 建议形态：结构化 JSON，批准后服务端机械应用
- 技术栈：零依赖 Node.js + 单页 HTML，目录 /workspace/dual-agent
