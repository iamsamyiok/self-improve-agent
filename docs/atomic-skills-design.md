# 原子级技能设计方案

## 设计理念

原子级技能是最小可执行单元，具备：
1. 单一职责：只做一件事
2. 不可再分：无法拆分为更小的有意义单元
3. 明确输入输出：清晰的参数和返回值
4. 可组合性：多个技能可组合成复杂工作流

---

## 一、核心原子技能（基础设施层）

### 1. file.read
- **功能**：读取文件内容
- **输入**：`path` (string)
- **输出**：文件内容字符串
- **用途**：所有文件操作的基础

### 2. file.write
- **功能**：写入文件（覆盖/追加）
- **输入**：`path` (string), `content` (string), `append` (boolean)
- **输出**：写入确认
- **用途**：创建新文件或更新现有文件

### 3. file.edit
- **功能**：编辑文件特定部分
- **输入**：`path` (string), `oldText` (string), `newText` (string)
- **输出**：编辑结果
- **用途**：精确修改文件内容

### 4. file.list
- **功能**：列出目录内容
- **输入**：`path` (string)
- **输出**：文件和目录列表
- **用途**：探索项目结构

### 5. file.search
- **功能**：搜索文件内容
- **输入**：`pattern` (string), `path` (string, optional), `include` (string, optional)
- **输出**：匹配的文件和行号
- **用途**：快速定位代码

---

## 二、执行原子技能（运行时层）

### 6. process.run
- **功能**：执行 shell 命令
- **输入**：`command` (string), `timeout` (number)
- **输出**：命令输出和退出码
- **用途**：运行工具、测试、构建

### 7. process.install
- **功能**：安装依赖包
- **输入**：`package` (string), `manager` (string: npm/pip/go)
- **输出**：安装结果
- **用途**：管理项目依赖

### 8. process.build
- **功能**：构建项目
- **输入**：`target` (string, optional), `flags` (array)
- **输出**：构建日志
- **用途**：编译代码、打包资源

### 9. process.test
- **功能**：运行测试
- **输入**：`pattern` (string, optional), `coverage` (boolean)
- **输出**：测试结果和覆盖率
- **用途**：验证代码正确性

---

## 三、代码原子技能（开发层）

### 10. code.create
- **功能**：创建新文件（带模板）
- **输入**：`path` (string), `template` (string)
- **输出**：创建确认
- **用途**：快速生成代码骨架

### 11. code.refactor
- **功能**：重构代码
- **输入**：`path` (string), `rule` (string), `options` (object)
- **输出**：重构结果
- **用途**：改进代码结构

### 12. code.analyze
- **功能**：分析代码质量
- **输入**：`path` (string), `metrics` (array)
- **输出**：分析报告
- **用途**：代码审查

### 13. code.generate
- **功能**：生成代码（基于模板/规则）
- **输入**：`type` (string), `params` (object)
- **输出**：生成的代码
- **用途**：脚手架、CRUD、测试用例

---

## 四、记忆原子技能（知识层）

### 14. memory.save
- **功能**：保存记忆（自动去重）
- **输入**：`level` (string), `content` (string), `tags` (array)
- **输出**：保存结果
- **用途**：持久化知识

### 15. memory.search
- **功能**：检索记忆
- **输入**：`query` (string), `level` (string)
- **输出**：匹配结果
- **用途**：知识召回

### 16. memory.delete
- **功能**：删除记忆
- **输入**：`id` (number)
- **output**：删除确认
- **用途**：清理过时信息

---

## 五、技能原子技能（能力层）

### 17. skill.create
- **功能**：创建新技能
- **输入**：`name` (string), `content` (string), `essential` (boolean)
- **output**：创建确认
- **用途**：沉淀方法论

### 18. skill.list
- **功能**：列出所有技能
- **input**：无
- **output**：技能列表
- **用途**：发现可用能力

### 19. skill.use
- **功能**：调用技能执行任务
- **input**：`name` (string), `params` (object)
- **output**：执行结果
- **用途**：复用已有能力

---

## 六、协作原子技能（编排层）

### 20. task.breakdown
- **功能**：拆解复杂任务
- **input**：`task` (string)
- **output**：子任务列表
- **用途**：任务分解

### 21. task.assign
- **功能**：分配任务给代理
- **input**：`subtask` (string), `agent` (string)
- **output**：分配结果
- **用途**：并行执行

### 22. task.collect
- **功能**：收集任务结果
- **input**：`agentIds` (array)
- **output**：聚合结果
- **用途**：结果整合

### 23. task.evaluate
- **功能**：评估任务完成度
- **input**：`task` (string), `result` (string)
- **output**：评估评分
- **用途**：质量检查

---

## 七、外部原子技能（集成层）

### 24. web.fetch
- **功能**：获取网页内容
- **input**：`url` (string)
- **output**：网页内容
- **用途**：信息获取

### 25. web.search
- **功能**：搜索网络信息
- **input**：`query` (string)
- **output**：搜索结果
- **用途**：知识补充

### 26. git.push
- **功能**：推送代码到远程
- **input**：`branch` (string), `message` (string)
- **output**：推送结果
- **用途**：版本控制

### 27. git.commit
- **功能**：提交代码变更
- **input**：`files` (array), `message` (string)
- **output**：提交结果
- **用途**：版本控制

---

## 八、设计原则

### 1. 接口统一
```javascript
{
  name: string,           // 技能名称
  description: string,    // 功能描述
  params: object,         // 参数定义（JSON Schema）
  run: function(args, ctx) // 执行函数
}
```

### 2. 错误处理
- 失败时必须抛出 Error
- 返回结构化错误信息
- 不吞没异常

### 3. 幂等性
- 相同输入产生相同输出
- 避免副作用
- 支持重试

### 4. 可组合
- 小技能组合成大技能
- 单一技能可被多次使用
- 无状态设计

---

## 九、示例：组合使用

### 场景：创建 React 组件

```
1. task.breakdown("创建一个登录表单组件")
   ↓
   ["创建组件文件", "添加样式", "编写测试", "更新导出"]

2. code.create("src/components/LoginForm.tsx", "react-ts")
   ↓
   生成组件骨架

3. file.edit("src/components/LoginForm.tsx", oldText, newText)
   ↓
   添加具体实现

4. process.run("npm test LoginForm")
   ↓
   验证测试通过

5. skill.use("validate-component", { path: "src/components/LoginForm.tsx" })
   ↓
   质量检查

6. git.commit(["src/components/LoginForm.tsx"], "feat: add LoginForm")
   ↓
   提交代码

7. memory.save("long", "创建了 LoginForm 组件，使用 TypeScript + Tailwind", ["项目", "React"])
   ↓
   保存知识
```

---

## 十、实施建议

### 优先级排序

**P0（核心）**：file.read/write/edit, process.run, memory.save/search
**P1（常用）**：code.create/generate, task.breakdown, git.commit/push
**P2（增强）**：code.analyze/refactor, task.evaluate, web.search
**P3（扩展）**：skill.use, 第三方集成

### 实现步骤

1. 先实现 P0 核心技能
2. 测试每个技能的独立功能
3. 逐步添加 P1 常用技能
4. 组合使用验证工作流
5. 根据反馈迭代优化

---

## 十一、与现有系统对比

| 现有插件 | 对应原子技能 | 说明 |
|---------|-------------|------|
| write.js | file.write | 已实现 |
| bash.js | process.run | 已实现 |
| memory.js | memory.save/search | 已实现 |
| skill.js | skill.create/list | 已实现 |
| read.js | file.read | 待实现 |
| edit.js | file.edit | 待实现 |
| fetch.js | web.fetch | 已实现 |

---

## 总结

这套原子级技能设计遵循：
- 最小可执行单元原则
- 单一职责原则
- 高内聚低耦合原则
- 可组合性原则

通过合理组合这些原子技能，可以构建出复杂的工作流，同时保持系统的灵活性和可维护性。
