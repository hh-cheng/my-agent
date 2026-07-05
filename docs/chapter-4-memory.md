# 第四章：Memory 跨会话记忆

Session 持久化保存的是“对话记录”，Memory 保存的是“以后还值得记住的信息”。

这两者不要混在一起：

- Session 是完整流水账：用户说了什么、模型调了什么工具、工具返回了什么。
- Memory 是人工或 Agent 筛选后的长期线索：用户偏好、项目约定、反馈、参考资料。

当前实现的目标很朴素：不做复杂数据库，直接把记忆存成 Markdown 文件。这样适合教学，也方便人类检查和修改。

### 1. MemoryStore：把记忆落到 `.memory/`

核心代码在 [src/memory/store.ts](../src/memory/store.ts)。启动时入口会创建一个 MemoryStore：

```ts
const memoryStore = new MemoryStore('.')
await memoryStore.init()
toolRegistry.register(createMemoryTool(memoryStore))
```

它会在项目根目录下维护一个 `.memory/`：

```text
.memory/
  MEMORY.md                  # prompt 里使用的紧凑索引
  user_typescript.md          # 单条记忆
  project_deploy-process.md   # 单条记忆
```

每条记忆是一个带 frontmatter 的 Markdown 文件：

```md
---
name: 用户偏好 TypeScript
description: 用户更喜欢 TypeScript 示例
type: user
---

用户明确表示偏好 TypeScript。在需要写示例代码时，优先使用 TypeScript。
```

`type` 目前只允许四类：

- `user`：用户偏好或长期信息
- `feedback`：用户对 Agent 行为的反馈
- `project`：当前项目的长期约定
- `reference`：外部资料或稳定参考

保存记忆时，`MemoryStore.save()` 会同时做两件事：

1. 写入单条 Markdown 文件。
2. 更新 `.memory/MEMORY.md` 索引。

索引是放进 system prompt 的内容，单条文件则在需要细节时再通过工具读取。这样可以避免把所有记忆全文都塞进上下文。

### 2. memory 工具：让模型自己管理记忆

Memory 暴露给模型的是一个工具：[src/tools/memory-tools.ts](../src/tools/memory-tools.ts)。

```ts
export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description:
      '管理跨会话记忆。action: save | list | search | read | delete | lint',
    isConcurrencySafe: false,
    isReadOnly: false,
    // ...
  }
}
```

它支持六个 action：

- `save`：保存或覆盖一条记忆，需要 `name`、`type`、`content`
- `list`：列出记忆索引
- `search`：按关键词搜索记忆
- `read`：按文件名读取完整记忆
- `delete`：按文件名删除记忆
- `lint`：检查重复、过期路径等问题

这里把 `memory` 标记成 `isConcurrencySafe: false`，因为它会读写 `.memory/` 和索引文件。让它独占执行，可以避免并发保存时索引互相覆盖。

### 3. memoryContext：只把索引放进 system prompt

Memory 不是通过重新加载 session 实现的，而是每轮重新构建 system prompt 时注入：

```ts
const builder = new PromptBuilder()
  .pipe('memoryContext', () => memoryStore.buildPromptSection())
```

`buildPromptSection()` 只放三类信息：

- 当前有多少条记忆
- `.memory/MEMORY.md` 索引
- 记忆使用原则

其中最重要的原则是：

```text
记忆是线索，不是事实——使用前先用工具验证（read_file、grep 确认）
```

这条规则很关键。Memory 可能过期，尤其是记录了文件路径、命令、项目结构时。Agent 可以用 Memory 帮自己定位，但不能把 Memory 当作事实来源。

### 4. Slash commands：给人类看的 Memory 操作

除了模型可用的 `memory` 工具，终端里还有几个命令，代码在 [src/commands/memory.ts](../src/commands/memory.ts)：

```text
/memory
/memory search <query>
/lint
/dream
```

这些命令在 readline 循环里被拦截，不会写进 `messages`。其中 `/dream` 比较特殊：它会构造一个整理记忆库的用户消息，然后调用 `agentLoop`，让 Agent 自己执行：

1. `memory lint`
2. 根据 lint 结果删除、合并或更新记忆
3. 输出整理报告

这就是一个很小的“睡眠整理”机制。它没有后台任务，也没有自动运行；需要用户显式输入 `/dream`。

### 5. Memory 的测试

Memory 有两层测试：

```bash
bun test src/memory/store.test.ts src/tools/memory-tools.test.ts
bun run test:e2e:dream
```

单元测试验证保存、搜索、读取、删除和 lint；E2E 验证 `/dream` 能通过 Agent Loop 调用 memory 工具并清理过期记忆。
