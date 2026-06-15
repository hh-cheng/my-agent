# My Agent

一个手搓 Agent 的 TypeScript 教学项目。

这个项目不是为了封装一个通用框架，而是把 ChatBot 演进成 Agent 的关键机制拆开写清楚：

- 给模型注册工具
- 监听模型流式输出里的 `tool-call` / `tool-result`
- 把工具调用结果写回 `messages`
- 用 `while` 循环让模型继续思考和行动
- 给循环加上重试、预算和死循环防护

当前进度：

- 第一章：Agent Loop 已完成
- 第二章：Tool System 实现中

## 快速开始

安装依赖：

```bash
bun install
```

启动交互式 Demo：

```bash
bun run dev
```

如果没有配置真实模型 API key，项目会自动使用本地 mock model：

```bash
# 可选：使用真实 DeepSeek
DEEPSEEK_API_KEY=你的_key bun run dev
```

也可以复制示例环境变量文件后再填写：

```bash
cp .env.example .env
```

联网搜索工具是可选能力。配置 `TAVILY_API_KEY` 后会优先使用 Tavily；如果没有 Tavily 但配置了 `SERPER_API_KEY`，会回退到 Serper。详细说明见 [docs/search-tools.md](docs/search-tools.md)。

退出：

```text
exit
```

运行测试：

```bash
bun test
```

## 项目结构

```text
src/
  index.ts                    # 入口：注册模型、工具、消息历史并启动对话
  mock/
    mock-model.ts             # 无 API key 时使用的本地模拟模型
    mock-index.ts             # v0.1 ChatBot 阶段示例
  tools/
    tool-registry.ts          # 工具注册、结果截断、并发控制
    utility-tools.ts          # weather / calculator / 文件读写 / 目录列表工具
    search-tools.ts           # Tavily / Serper 搜索和网页抓取工具
  agent/
    loop.ts                   # Agent Loop 核心实现
    retry.ts                  # API 失败重试策略
    loop-detection.ts         # 循环检测和熔断
    loop.test.ts              # Agent Loop 重试和预算测试
    loop-detection.test.ts    # 循环检测测试
```

## 从 ChatBot 到 Agent

普通 ChatBot 的核心流程通常是：

1. 用户输入追加到 `messages`
2. 调用模型
3. 把模型文本输出给用户
4. 把 assistant 回复追加到 `messages`

Agent 的差异在于：模型不只输出文本，还可以决定调用工具。工具结果回来后，模型需要继续读上下文，再决定是否继续调用工具或输出最终答案。

所以 Agent Loop 的核心是这段循环：

```ts
while (step < MAX_STEPS) {
  const result = streamText({
    model,
    system,
    tools,
    messages,
  })

  for await (const part of result.fullStream) {
    // text-delta: 输出文本
    // tool-call: 模型要求调用工具
    // tool-result: 工具执行结果
  }

  const stepMessages = await result.response
  messages.push(...stepMessages.messages)

  if (!hasToolCall) break
}
```

关键点是 `fullStream`。如果只用 `textStream`，你只能拿到文本；用 `fullStream` 才能看到工具调用事件。

## 第二章：Tool System

工具主要在 [src/tools/utility-tools.ts](src/tools/utility-tools.ts) 和 [src/tools/search-tools.ts](src/tools/search-tools.ts) 里定义。当前包括：

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

联网搜索工具需要额外配置 API key，见 [docs/search-tools.md](docs/search-tools.md)。

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
toolRegistry.registry(...allTools)
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

入口 [src/index.ts](src/index.ts) 会注册：

```ts
toolRegistry.registry(pickSearchTool(), webFetchTool)
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

核心状态在 [src/tools/tool-registry.ts](src/tools/tool-registry.ts)：

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

## 第一章：Agent Loop

## 为什么要把 response.messages 写回 messages

工具调用不是一次模型请求内的“本地函数调用”那么简单。模型需要在下一轮看到：

- 它刚才请求了哪个工具
- 工具返回了什么结果
- 之前的用户问题是什么

所以每轮结束后要执行：

```ts
const stepMessages = await result.response
messages.push(...stepMessages.messages)
```

如果不写回，模型下一轮不知道工具已经执行过，很容易重复调用同一个工具。

## 增强版 Agent Loop：agentLoop

`agentLoop` 是更接近生产思路的版本，包含三类防护。

### 1. API 失败重试

`agentLoop` 关闭了 SDK 内置重试：

```ts
maxRetries: 0
```

然后自己在外层包了一层重试：

```ts
for (let attempt = 1; ; attempt++) {
  try {
    const result = streamText(...)
    // 消费 fullStream
    break
  } catch (err) {
    if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err
    await sleep(calculateDelay(attempt))
  }
}
```

`src/agent/retry.ts` 里把这些错误视为可重试：

- `429`
- `529`
- `408`
- `5xx`
- `ECONNRESET`
- `EPIPE`
- `ETIMEDOUT`
- `fetch failed`
- `network`
- `No output generated`

明确的 `4xx` 请求错误不会重试。

### 2. Token 预算防护

`agentLoop` 接收一个由调用方持有的预算对象：

```ts
export type BudgetState = {
  used: number
  limit: number
}
```

每轮模型调用结束后读取 usage：

```ts
const take = stepUsage.inputTokens ?? 0
const out = stepUsage.outputTokens ?? 0
budget.used += take + out
```

如果超过 `budget.limit`，就停止继续调用模型：

```ts
if (budget.used > budget.limit) {
  console.log('\n[预算超支，强制停止]')
  break
}
```

这个设计让预算可以跨多轮用户对话累积，而不是只限制单次请求。

### 3. 循环检测和熔断

Agent 最容易出的问题之一是“看起来在工作，其实一直原地打转”。当前实现检测三种情况：

- `generic_repeat`：同一个工具、同一组参数被反复调用
- `ping_pong`：两组参数 A/B/A/B 来回切换
- `global_circuit_breaker`：同一个调用连续返回相同结果，说明没有进展

检测数据放在滑动窗口里：

```ts
const HISTORY_SIZE = 30
```

每次工具调用前检测：

```ts
const detection = detect(part.toolName, part.input)
```

如果是 warning，会往 `messages` 注入一条系统提醒，让模型换思路：

```ts
messages.push({
  role: 'user',
  content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
})
```

如果是 critical，就直接停止 loop。

## 一次工具调用的完整流程

以“帮我算一下 2 + 3 * 4”为例：

1. 用户输入进入 `messages`
2. `streamText` 收到 `tools`
3. 模型判断需要调用 `calculator`
4. `fullStream` 产生 `tool-call`
5. AI SDK 执行 `calculator.execute`
6. `fullStream` 产生 `tool-result`
7. `result.response.messages` 包含 assistant tool-call 和 tool-result
8. loop 把这些消息写回 `messages`
9. 因为本轮有工具调用，进入下一轮
10. 模型读到工具结果，输出最终答案
11. 本轮没有工具调用，loop 结束

## 当前测试覆盖

运行：

```bash
bun test
```

当前测试主要覆盖两块。

`loop-detection.test.ts`：

- 重复调用 warning
- 重复调用 critical
- 参数 key 顺序稳定 hash
- ping-pong 检测
- 无进展熔断
- resetHistory 清空状态

`loop.test.ts`：

- retryable API 失败后重试
- 消费 stream 过程中失败后重试
- 非 retryable 错误不重试
- 达到最大重试次数后抛出
- 预算内继续执行
- 超预算后停止下一次模型调用

## 可以继续扩展的方向

- 给工具执行增加超时控制
- 把循环检测结果结构化返回给上层 UI
- 增加更真实的工具，例如数据库查询、浏览器自动化、长期记忆
- 用 trace id 记录每一轮 step、tool-call、tool-result 和 token usage
