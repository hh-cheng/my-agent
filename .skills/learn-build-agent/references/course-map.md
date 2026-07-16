# 新仓库手写 Agent 课程地图

## 目录

- [使用原则](#使用原则)
- [核心路线](#核心路线)
- [阶段 0：新仓库与最小 ChatBot](#阶段-0新仓库与最小-chatbot)
- [阶段 1：工具协议](#阶段-1工具协议)
- [阶段 2：Agent Loop](#阶段-2agent-loop)
- [阶段 3：循环防线](#阶段-3循环防线)
- [阶段 4：Context、Session 与 Usage](#阶段-4contextsession-与-usage)
- [阶段 5：Memory](#阶段-5memory)
- [阶段 6：RAG](#阶段-6rag)
- [阶段 7：Skills、Plugins 与 Channels](#阶段-7skillsplugins-与-channels)
- [阶段 8：安全、Cron、Multi-Agent 与装配](#阶段-8安全cronmulti-agent-与装配)

## 使用原则

所有“产物”和“测试”都写入 `STUDENT_REPO`。所有“参考”都只从 `REFERENCE_REPO` 读取。先让学生实现最小方案，再查看参考代码比较；不要复制整文件。

每阶段建立一个可运行检查点。学生完成阶段 4 即可视为完成核心手写 Agent；阶段 5–8 是按兴趣选择的进阶能力。

## 核心路线

```text
空仓库
  → 最小 ChatBot
  → Tool contract + registry
  → Agent Loop + message feedback
  → retry / budget / loop detection
  → context / session / usage
  → 可选：Memory / RAG / Extensions / Security
```

## 阶段 0：新仓库与最小 ChatBot

**目标**：建立独立 Bun + TypeScript 仓库；区分模型、Runtime 和消息历史。

**学生产物**：

- 最小 `package.json`、`tsconfig.json` 和 `.gitignore`；
- `src/types.ts`：最简单的 user/assistant message；
- `src/model.ts`：可预测的本地假模型端口；
- `src/index.ts`：把用户消息交给模型并保存回复；
- 一个证明第二轮能看到历史的测试。

**不要提前加入**：工具、Agent Loop、复杂目录、真实 API Key。

**参考**：

- `src/mock/mock-index.ts`
- `src/mock/mock-model.ts`
- `docs/chapter-1-agent-loop.md`

**过关证据**：学生能解释模型不等于 Agent，消息历史由 Runtime 管理。

## 阶段 1：工具协议

**目标**：让模型能够表达“我要调用某个工具”，并由 Runtime 验证和执行。

**学生产物**：

- `ToolDefinition` 与最小参数协议；
- 一个 `calculator` 工具；
- 一个按名称注册和查找工具的 registry；
- 工具不存在、输入非法和执行成功的测试。

先使用清晰的手写类型；在需要连接真实模型时再引入 JSON Schema/Zod 或 AI SDK 转换。

**参考**：

- `src/tools/tool-registry.ts`
- `src/tools/utility-tools.ts`
- `docs/chapter-2-tool-system.md`

**过关证据**：学生能区分模型描述工具、Runtime 执行工具和工具返回数据三个职责。

## 阶段 2：Agent Loop

**目标**：亲手实现 `model → tool call → tool result → model` 循环。

**学生产物**：

- `src/agent/loop.ts`；
- tool-call 与 tool-result 消息类型；
- 把每一步响应写回共享消息历史的逻辑；
- “有工具调用则继续、只有文本则结束”的退出条件；
- 一次 calculator 两步对话的确定性测试。

**关键实验**：暂时不写回 tool result，观察假模型为何重复调用或无法回答，再恢复实现。

**参考**：

- `src/agent/loop.ts`
- `src/agent/loop.test.ts`
- `docs/chapter-1-agent-loop.md`

**过关证据**：学生能逐轮列出 messages 的新增内容，并解释消息回写不变量。

## 阶段 3：循环防线

**目标**：让 Agent 在模型或外部服务异常时可控停止。

**学生产物**：

- 最大步数；
- 可测试的重试判断与退避函数；
- 调用预算；
- 至少一种重复工具调用检测；
- 对应失败测试和停止原因。

一次只加入一种防线，先复现失败再实现。不要一开始照搬完整生产策略。

**参考**：

- `src/agent/retry.ts`
- `src/agent/loop-detection.ts`
- `src/agent/loop-detection.test.ts`
- `e2e/agent-loop-defense.e2e.ts`

**过关证据**：学生能区分 API 重试、预算停止、重复调用告警和熔断。

## 阶段 4：Context、Session 与 Usage

**目标**：控制模型看见什么、保存什么，并观察成本。

**学生产物**：

- 可组合的 system prompt；
- 工具结果长度限制或上下文预算；
- JSONL 或等价的增量 session store；
- 最小 token/调用次数追踪；
- 恢复会话但不重复保存旧消息的测试。

**参考**：

- `src/context/prompt-builder.ts`
- `src/context/defense.ts`
- `src/context/compressor.ts`
- `src/session/store.ts`
- `src/usage/tracker.ts`
- `docs/chapter-3-context-engineering.md`

**核心结业证据**：学生能从入口完整解释一条用户消息如何调用模型、执行工具、更新上下文、停止并持久化。

## 阶段 5：Memory

**目标**：在 conversation 之外保存可跨会话使用的事实，同时保持可核实性。

**学生产物**：最小 memory store、索引/搜索、memory tool，以及“记忆是提示而非事实来源”的 prompt 规则。

**参考**：

- `src/memory/store.ts`
- `src/memory/validator.ts`
- `src/tools/memory-tools.ts`
- `docs/chapter-4-memory.md`

**过关证据**：学生能判断信息应留在 conversation、写入 Memory，还是重新从工具核实。

## 阶段 6：RAG

**目标**：理解 chunk → embed → store → retrieve，而不是把向量数据库当作黑盒。

**学生产物**：先用固定向量或可测试 embedder 完成分块、相似度和检索，再选择是否接真实 embedding 与 SQLite/FTS。

**参考**：

- `src/rag/chunker.ts`
- `src/rag/search.ts`
- `src/rag/sqlite-store.ts`
- `src/tools/rag-tools.ts`
- `docs/chapter-5-rag.md`

**过关证据**：学生能解释 RAG 与 Memory 的数据来源、更新方式和可信边界。

## 阶段 7：Skills、Plugins 与 Channels

**目标**：分别扩展方法、能力和入口。

**学生产物**：按兴趣选择一个最小扩展：prompt skill loader、带卸载回收的 plugin，或独立 session 的 channel gateway。

**参考**：

- `src/skills/loader.ts`
- `src/plugins/manager.ts`
- `src/channels/gateway.ts`
- `e2e/plugins.e2e.ts`
- `docs/chapter-6-skills-plugins-channels.md`

**过关证据**：学生能说出 Skill、Plugin、Channel 各自改变 Runtime 的哪一层。

## 阶段 8：安全、Cron、Multi-Agent 与装配

**目标**：理解 Agent 获得写入、Shell、时间触发和任务派发能力后的边界。

**学生产物**：不要一次实现全部。选择一个垂直切片，并补确定性测试：

- 按角色过滤模型可见工具；或
- pre/post tool hook；或
- 可停止的定时任务；或
- 具有深度、并发和超时限制的子 Agent；或
- 带 schema 默认值与环境变量替换的 Runtime 配置。

**参考**：

- `src/security/roles.ts`
- `src/security/hooks.ts`
- `src/cron/service.ts`
- `src/agents/spawn.ts`
- `src/config/schema.ts`
- `src/main.ts`
- `docs/chapter-7-security-cron-multi-agent.md`
- `docs/chapter-8-config-and-cli.md`

**过关证据**：学生能指出该能力的触发源、状态所有者、安全边界、停止/清理路径和测试策略。

## 每阶段验收模板

```text
目标行为：
学生仓库文件：
先失败的测试：
最小实现：
运行命令：
学生复述：
尚未实现：
下一检查点：
```
