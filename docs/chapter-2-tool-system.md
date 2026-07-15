# 第二章：Tool System

工具主要在 [src/tools/utility-tools.ts](../src/tools/utility-tools.ts) 和 [src/tools/search-tools.ts](../src/tools/search-tools.ts) 里定义。作为教学版，当前已经覆盖工具系统需要讲清楚的核心能力：

- `get_weather`：查询 mock 天气
- `calculator`：计算数学表达式
- `read_file`：读取文件内容
- `write_file`：写入文件
- `list_directory`：列出目录内容
- `edit_file`：精确替换文件中的一段内容
- `glob`：按通配符模式搜索文件
- `grep`：在文件中搜索正则匹配内容
- `bash`：执行 shell 命令并返回输出
- `fetch_url`：抓取 URL 并提取纯文本
- `start_preview`：启动 `app/` 目录的本地预览服务器
- `web_search`：联网搜索，自动在 Tavily / Serper 间选择
- `web_fetch`：抓取指定网页并转换为 Markdown
- `memory`：保存、搜索、读取、删除和 lint 跨会话记忆
- `rag_ingest`：把本地文档分块、向量化并写入知识库
- `rag_search`：从知识库里做混合检索

联网搜索工具需要额外配置 API key，见 [docs/search-tools.md](search-tools.md)。
RAG 工具需要配置 `EMBED_API_KEY`；没有配置时不会注册 `rag_ingest` 和
`rag_search`。

一个工具由三部分组成：

```ts
export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string' },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  execute: async ({ expression }: { expression: string }) => {
    const result = new Function(`return ${expression}`)()
    return `${expression} = ${result}`
  },
}
```

- `description` 告诉模型什么时候该用这个工具
- `parameters` 限制模型传入的参数形状
- `execute` 是真正执行工具逻辑的函数
- `isReadOnly` / `isConcurrencySafe` 给 Agent Loop 做调度决策
- `maxResultChars` 控制工具结果最多返回多少字符给模型

入口处先把工具注册到 `ToolRegistry`：

```ts
const toolRegistry = new ToolRegistry()
toolRegistry.register(...allTools)
```

Agent Loop 再把 registry 转成 AI SDK 需要的 tools 格式：

```ts
streamText({
  model,
  system,
  tools: tools.toAISDKFormat(),
  messages,
})
```

`ToolRegistry` 这一层目前负责三件事：

- 把项目内部的 `ToolDefinition` 转成 AI SDK 的 tool 格式
- 按 `maxResultChars` 截断工具结果，避免一次工具调用把上下文撑爆
- 按 `isConcurrencySafe` 控制工具并发，避免读写冲突

### 搜索工具选择

Runtime 装配层 [src/main.ts](../src/main.ts) 会注册：

```ts
toolRegistry.register(pickSearchTool(), webFetchTool)
```

`pickSearchTool()` 的选择规则是：

1. 配置了 `TAVILY_API_KEY`：注册 Tavily 版 `web_search`
2. 否则配置了 `SERPER_API_KEY`：注册 Serper 版 `web_search`
3. 两者都没有：仍注册 Tavily 版 `web_search`，但调用时会提示缺少 `TAVILY_API_KEY`

`web_fetch` 不需要 API key，会直接抓取给定 URL，并用 Turndown 把 HTML 转成 Markdown。

## Tool Result 截断

`read_file` 这类工具可能返回很长的内容，所以工具执行结果不会原样全部交给模型。`ToolRegistry` 会在包装工具时做截断：

```ts
return truncate(text, maxChars)
```

截断策略是保留头部和尾部：

```ts
const headSize = Math.floor(maxChars * 0.6)
const tailSize = maxChars - headSize
```

例如 `read_file.maxResultChars = 500`，模型拿到的是大约前 300 字符、后 200 字符，以及一条“截断了多少字符”的提示。这样模型能知道结果不完整，不会误以为自己看到了整个文件。

注意：`loop.ts` 里控制台打印的 `[结果: ...]` 还有一层 120 字符 preview，那只是给人看的日志，不代表模型只收到了 120 字符。

## 工具并发控制：读写锁

第二章的 Tool System 还引入了一个轻量读写锁。目标是：

- 多个并发安全工具可以同时跑，例如多个 `read_file` / `list_directory`
- 非并发安全工具必须独占执行，例如 `write_file`
- 写工具执行时，新的读工具要等
- 读工具执行中，写工具要等所有读工具结束

核心状态在 [src/tools/tool-registry.ts](../src/tools/tool-registry.ts)：

```ts
private exclusiveLock = false
private concurrentCount = 0
private waitQueue: Array<(ipt: unknown) => void> = []
```

这三个变量组成一把读写锁：

- `exclusiveLock`：当前是否有独占工具正在执行
- `concurrentCount`：当前有多少个共享工具正在执行
- `waitQueue`：被阻塞工具的唤醒函数队列

共享锁用于并发安全工具：

```ts
private async acquireConcurrent() {
  while (this.exclusiveLock) {
    await new Promise((r) => this.waitQueue.push(r))
  }
  this.concurrentCount++
}
```

只要没有独占锁，共享工具就能继续执行，并把 `concurrentCount` 加一。多个共享工具可以同时持有锁。

独占锁用于非并发安全工具：

```ts
private async acquireExclusive() {
  while (this.exclusiveLock || this.concurrentCount > 0) {
    await new Promise((r) => this.waitQueue.push(r))
  }
  this.exclusiveLock = true
}
```

独占工具必须等到没有写工具、也没有读工具时才能继续。

这里容易误解的是：

```ts
await new Promise((r) => this.waitQueue.push(r))
```

锁不是靠 `Promise.resolve()` 自动实现的，而是靠“保存 Promise 的 `resolve` 函数，稍后手动调用它”实现等待和唤醒。

当一个写工具发现当前还有读工具在执行时，它会创建一个新的 Promise，并把这个 Promise 的 `resolve` 函数放进 `waitQueue`。这个 Promise 暂时没有被 resolve，所以 `await` 会暂停当前 async 函数的后半段。暂停的是这个工具调用，不是整个 JS 线程；事件循环仍然可以继续跑，正在执行的读工具也能继续完成。

等最后一个读工具结束时：

```ts
private releaseConcurrent() {
  this.concurrentCount--
  if (this.concurrentCount === 0) this.drainQueue()
}
```

它会调用：

```ts
private drainQueue() {
  const waiting = this.waitQueue.splice(0)
  for (const resolve of waiting) resolve(void 0)
}
```

这一步会手动调用之前保存的 `resolve`，于是等待中的写工具从 `await` 后恢复执行。恢复后它不会直接认为自己拿到了锁，而是重新回到 `while` 判断。只有当 `exclusiveLock === false` 且 `concurrentCount === 0` 时，才会跳出循环并设置：

```ts
this.exclusiveLock = true
```

这时写工具才真正拿到独占锁，随后才会执行 `write_file` 的真实写入逻辑。

`while` 很重要，因为 `drainQueue()` 会一次唤醒所有等待者。被唤醒不等于已经拿到锁，只是获得了重新竞争锁的机会。
