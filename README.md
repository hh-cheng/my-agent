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
- 第三章：Context Engineering 已实现基础版

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
  session/
    store.ts                  # 会话持久化：把 messages 追加写入 jsonl
  context/
    prompt-builder.ts         # Prompt Pipe：按模块组装 system prompt
    prompts.ts                # coreRules / toolGuide / sessionContext 等 prompt 片段
    compressor.ts             # 上下文压缩：microCompact + LLM summarize
    compressor.test.ts        # 压缩单元测试
  agent/
    loop.ts                   # Agent Loop 核心实现
    retry.ts                  # API 失败重试策略
    loop-detection.ts         # 循环检测和熔断
    loop.test.ts              # Agent Loop 重试和预算测试
    loop-detection.test.ts    # 循环检测测试
e2e/
  compressor.e2e.ts           # 真实模型压缩 E2E
  defense.e2e.ts              # Context defense E2E
  agent-loop-defense.e2e.ts   # Agent Loop 防线 E2E
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

## 第三章：Context Engineering

Agent 能调用工具之后，下一个问题不是“怎么让它更聪明”，而是“怎么管理它看到的上下文”。

模型每次请求真正能看到的东西只有两类：

- `system`：告诉模型它是谁、有哪些规则、有哪些上下文约束
- `messages`：用户、assistant、tool result 组成的对话历史

Context Engineering 做的就是管理这两类输入。当前项目实现了三件事：

- Session 持久化：把对话历史保存下来，下次可以继续
- Prompt 组装：把 system prompt 拆成可组合的模块
- Compression：历史太长时，把旧上下文压缩成摘要

这三件事的目标不是“省 token”这么简单，而是让 Agent 在多轮任务里保持连续性：它要记得做过什么、读过哪些文件、工具返回过什么关键信息，同时又不能把所有原始日志无限塞进模型窗口。

### 1. Session 持久化：让 Agent 记得上一轮发生了什么

最朴素的 ChatBot 通常把 `messages` 放在内存里。进程一退出，历史就没了。Agent 不一样，它经常要跨多轮完成任务，所以需要把对话历史落盘。

当前实现放在 [src/session/store.ts](src/session/store.ts)：

```ts
export class SessionStore {
  append(message: ModelMessage) {
    const entry: SessionEntry = {
      message,
      type: 'message',
      timestamp: new Date().toISOString(),
    }
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
  }

  load(): ModelMessage[] {
    // 逐行读取 jsonl，再还原成 ModelMessage[]
  }
}
```

这里用的是 JSONL，而不是一个大的 JSON 数组：

- 每次新增消息只需要追加一行，不需要重写整个文件
- 进程中途退出时，已经写入的历史仍然保留
- 后续想加 trace id、usage、工具耗时，也可以扩展每一行的结构

入口 [src/index.ts](src/index.ts) 里根据 `--continue` 决定是否恢复历史：

```ts
const isContinue = process.argv.includes('--continue')
const sessionId = 'default'
const store = new SessionStore(sessionId)

let messages: ModelMessage[] = []
if (isContinue && store.exists()) {
  messages = store.load()
}
```

运行方式：

```bash
bun run continue
```

每轮用户对话结束后，只保存本轮新增消息：

```ts
const beforeCount = messages.length
messages.push(userMessage)

await agentLoop({ messages, ... })

store.appendAll(messages.slice(beforeCount))
```

这里的 `beforeCount` 很关键。`agentLoop` 会把 assistant 回复、tool-call、tool-result 都追加进同一个 `messages` 数组。如果直接保存整个数组，每一轮都会重复写入旧历史。用 `slice(beforeCount)` 就只保存本轮新增的部分。

### 2. Prompt 组装：不要把 system prompt 写成一整坨字符串

随着 Agent 能力增加，system prompt 会越来越长：

- 基础行为规则
- 工具使用说明
- MCP / deferred tools 提示
- 当前 session 信息
- 未来可能还有安全策略、项目约束、输出格式要求

如果全部写在一个模板字符串里，很快会变得难维护。当前项目把 system prompt 拆成一组 pipe，核心在 [src/context/prompt-builder.ts](src/context/prompt-builder.ts)：

```ts
export type PipeFn = (ctx: PromptContext) => string | null

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn) {
    this.pipes.push({ name, fn })
    return this
  }

  build(ctx: PromptContext) {
    const sections: string[] = []

    for (const { fn } of this.pipes) {
      const result = fn(ctx)
      if (result !== null) sections.push(result)
    }

    return sections.join('\n\n')
  }
}
```

一个 pipe 就是一个“可开关的 prompt 片段”。例如 [src/context/prompts.ts](src/context/prompts.ts) 里的 `toolGuide`：

```ts
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`
  }
}
```

它的特点是：prompt 片段可以根据上下文决定是否出现。没有工具时，`toolGuide` 返回 `null`；有工具时才把说明放进 system prompt。

入口处的组装方式是：

```ts
const builder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('sessionContext', sessionContext())

const SYSTEM = builder.build(promptCtx)
```

这个结构比一个巨大字符串更适合教学和扩展：

- 新增规则时，只新增一个 pipe
- 临时关闭某段 prompt 时，只移除一行 `.pipe(...)`
- 每段 prompt 都可以单独测试
- `builder.debug(ctx)` 可以打印每段是否启用，以及生成了多少字符

### 3. Compression：上下文不是越多越好

Session 持久化解决的是“记住历史”，但它会带来新问题：历史会越来越长。

如果把所有历史原样塞进模型，会有几个问题：

- token 成本越来越高
- 请求越来越慢
- 工具结果日志会挤掉真正重要的信息
- 模型可能被旧的、低价值细节干扰

所以第三章引入两层压缩，代码在 [src/context/compressor.ts](src/context/compressor.ts)。

第一层是 `microCompact`：不调用模型，只清理旧工具结果。

```ts
const KEEP_RECENT_TOOL_RESULTS = 3

export function microCompact(messages: ModelMessage[]) {
  // 找到所有 tool result
  // 保留最近 3 个
  // 更早的 read_file / bash / grep / glob 等结果替换为占位符
}
```

为什么只清理旧工具结果？因为 tool result 往往最占上下文。例如 `read_file` 可能返回几千字符，`grep` 可能返回一大串匹配结果。旧工具结果的完整原文通常不需要一直保留，保留一句：

```text
[tool result cleared]
```

就足够告诉模型：这里曾经有过一个工具结果，但原文已经被清理。

第二层是 `summarize`：调用模型，把较早的对话压缩成结构化摘要。

```ts
const KEEP_RECENT_MESSAGES = 6
const CONTEXT_TOKEN_THRESHOLD = 300
```

当前策略是：

1. token 估算没超过阈值，不压缩
2. 消息数不超过最近窗口，不压缩
3. 保留最近 6 条消息原文
4. 把更早的消息整理成 `conversationText`
5. 调用模型生成摘要
6. 用一条新的 `user` 消息替换旧历史

压缩后的消息形状大致是：

```ts
[
  {
    role: 'user',
    content: `[以下是之前对话的压缩摘要]

## 用户意图
...

## 已完成的操作
...

[摘要结束，以下是最近的对话]`,
  },
  ...recentMessages,
]
```

这里刻意把摘要放成一条 `user` 消息，而不是放进 `system`。原因是：它描述的是“对话历史”，不是永久规则。`system` 更适合放稳定的行为约束；历史摘要应该跟着 `messages` 一起参与上下文管理。

摘要 prompt 要求模型输出固定结构：

```text
## 用户意图
## 已完成的操作
## 关键发现
## 当前状态
## 需要保留的细节
```

这个结构的目的不是好看，而是降低信息丢失概率。普通自然语言摘要很容易写成“用户询问了项目情况”这种空话；结构化摘要会逼模型保留文件路径、变量名、版本号、错误信息这些后续任务真正需要的细节。

### 压缩触发点

当前有两个触发点。

程序启动并恢复 session 后，会先压缩历史：

```ts
const beforeTokens = estimateTokens(messages)

const mc = microCompact(messages)
messages = mc.messages

const compResult = await summarize(model, messages, summary)
messages = compResult.messages
summary = compResult.summary
```

每轮对话结束后，如果当前上下文超过 4000 token，也会再次压缩：

```ts
const currentTokens = estimateTokens(messages)
if (currentTokens > 4000) {
  const mc2 = microCompact(messages)
  messages = mc2.messages

  const summarizeResult = await summarize(model, messages, summary)
  messages = summarizeResult.messages
  summary = summarizeResult.summary
}
```

注意这里的 `estimateTokens` 只是教学项目里的粗略估算：

```ts
return Math.ceil(chars / 4)
```

真实生产系统通常会使用模型对应 tokenizer，或者直接依赖 API 返回的 usage。

### 用 E2E 看压缩效果

压缩逻辑有单元测试，也有一个真实模型 E2E：

```bash
bun run test:e2e:compression
```

这个测试会注入一段假的历史消息，包括：

- 列目录
- 读取 `package.json`
- 读取 `sample-data.txt`
- 搜索 `src` 里的 export

然后真实调用 DeepSeek 做摘要，并打印压缩前后的结果：

```text
[Compression E2E]
before: 16 messages, ~416 tokens
after microCompact: 16 messages, ~394 tokens, cleared 1 tool result(s)
after summarize: 9 messages, ~430 tokens, compressed 8 message(s)

[Summary]
...

[Compressed Messages]
...
```

这个 E2E 的价值不是追求 token 数一定下降。因为摘要是自然语言，模型可能写得更详细，短 fixture 下 token 不一定变少。它真正验证的是：

- 旧工具结果能被清理
- 旧消息能被折叠成摘要
- 最近几条消息仍保留原文
- 摘要能保留 `package.json`、版本号、文件名等关键信息

### 一个容易踩的坑：压缩输入必须包含正文

`summarize` 的核心是把旧消息转成 `conversationText`。这里不能只写角色名：

```text
**user**

**assistant**
```

这样模型根本不知道用户问了什么、工具返回了什么，自然不可能总结出有用信息。

当前实现会提取字符串消息、text part 和 tool output：

```ts
const content =
  typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content
          .map((p: any) => {
            if (typeof p.text === 'string') return p.text
            if (typeof p.output === 'string') return p.output
            if (Object.prototype.hasOwnProperty.call(p, 'output'))
              return JSON.stringify(p.output ?? '')
            return ''
          })
          .join('')
      : ''
```

这段看起来只是序列化细节，但它决定了 compression 有没有真实信息可压缩。Context Engineering 经常就是这种细节工程：不是多写几句 prompt，而是确保模型看到的是正确、完整、排序合理的上下文。

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

当前测试主要覆盖三块。

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

`compressor.test.ts`：

- `microCompact` 只清理较早的可清理工具结果
- 最近 3 个工具结果保持原样
- 低 token / 低消息量时不触发 summarize
- summarize 会保留最近窗口，并把旧消息压缩成摘要消息
- 模型摘要失败时回退到原始 messages
- `estimateTokens` 覆盖字符串、text part 和 tool output

真实模型压缩 E2E 需要单独运行：

```bash
bun run test:e2e:compression
```

## 可以继续扩展的方向

- 给工具执行增加超时控制
- 把循环检测结果结构化返回给上层 UI
- 增加更真实的工具，例如数据库查询、浏览器自动化、长期记忆
- 用 trace id 记录每一轮 step、tool-call、tool-result 和 token usage
- 把压缩摘要持久化到 session，避免每次启动都重新摘要同一段历史
