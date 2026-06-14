# My Agent

一个手搓 Agent Loop 的 TypeScript Demo。

这个项目不是为了封装一个通用框架，而是把 ChatBot 演进成 Agent 的关键机制拆开写清楚：

- 给模型注册工具
- 监听模型流式输出里的 `tool-call` / `tool-result`
- 把工具调用结果写回 `messages`
- 用 `while` 循环让模型继续思考和行动
- 给循环加上重试、预算和死循环防护

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
  index.ts                    # v0.2 入口：注册模型、工具、消息历史并启动对话
  mock-model.ts               # 无 API key 时使用的本地模拟模型
  mock-index.ts               # v0.1 ChatBot 阶段示例
  tools/
    utility-tools.ts          # weather / calculator 两个示例工具
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

## 工具定义

工具在 [src/tools/utility-tools.ts](src/tools/utility-tools.ts) 里定义。当前有两个工具：

- `get_weather`：查询 mock 天气
- `calculator`：计算数学表达式

一个工具由三部分组成：

```ts
export const calculatorTool = {
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  inputSchema: jsonSchema({
    type: 'object',
    properties: {
      expression: { type: 'string' },
    },
    required: ['expression'],
    additionalProperties: false,
  }),
  execute: async ({ expression }: { expression: string }) => {
    const result = new Function(`return ${expression}`)()
    return `${expression} = ${result}`
  },
}
```

- `description` 告诉模型什么时候该用这个工具
- `inputSchema` 限制模型传入的参数形状
- `execute` 是真正执行工具逻辑的函数

入口处把工具注册给模型：

```ts
const tools = {
  get_weather: weatherTool,
  calculator: calculatorTool,
}
```

然后传给 `streamText`：

```ts
streamText({
  model,
  system,
  tools,
  messages,
})
```

## 最小 Agent Loop：ask

[src/agent/loop.ts](src/agent/loop.ts) 里有两个 loop：

- `ask`：教学用的最小 Agent Loop
- `agentLoop`：带重试、预算、循环检测的增强版 Agent Loop

当前 [src/index.ts](src/index.ts) 使用的是 `ask`，方便观察最小闭环。

`ask` 做了几件事：

1. 调用 `streamText`
2. 遍历 `result.fullStream`
3. 遇到 `text-delta` 就打印文本
4. 遇到 `tool-call` / `tool-result` 就打印调试信息
5. 读取 `result.response`
6. 把本轮 assistant / tool 消息追加到 `messages`
7. 如果本轮没有工具调用，就结束
8. 如果本轮有工具调用，就进入下一轮

这就是 Agent Loop 的最小可运行版本。

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

- 把入口从 `ask` 切换到 `agentLoop`，启用完整防护能力
- 给工具执行增加超时控制
- 把循环检测结果结构化返回给上层 UI
- 增加更真实的工具，例如文件读写、搜索、数据库查询
- 用 trace id 记录每一轮 step、tool-call、tool-result 和 token usage

