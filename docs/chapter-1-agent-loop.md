# 第一章：Agent Loop

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
