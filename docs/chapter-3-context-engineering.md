# 第三章：Context Engineering

Agent 能调用工具之后，下一个问题不是“怎么让它更聪明”，而是“怎么管理它看到的上下文”。

模型每次请求真正能看到的东西只有两类：

- `system`：告诉模型它是谁、有哪些规则、有哪些上下文约束
- `messages`：用户、assistant、tool result 组成的对话历史

Context Engineering 做的就是管理这两类输入。当前项目实现了五件事：

- Session 持久化：把对话历史保存下来，下次可以继续
- Prompt 组装：把 system prompt 拆成可组合的模块
- Compression：历史太长时，把旧上下文压缩成摘要
- 三层防线：Token 估算、工具结果截断、TTL 修剪
- Prompt cache 追踪：统计 cache read / write、命中率和节省成本

这些机制的目标不是“省 token”这么简单，而是让 Agent 在多轮任务里保持连续性：它要记得做过什么、读过哪些文件、工具返回过什么关键信息，同时又不能把所有原始日志无限塞进模型窗口。

### 1. Session 持久化：让 Agent 记得上一轮发生了什么

最朴素的 ChatBot 通常把 `messages` 放在内存里。进程一退出，历史就没了。Agent 不一样，它经常要跨多轮完成任务，所以需要把对话历史落盘。

当前实现放在 [src/session/store.ts](../src/session/store.ts)：

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

Runtime 装配层 [src/main.ts](../src/main.ts) 里根据 `--continue` 决定是否恢复历史：

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

如果全部写在一个模板字符串里，很快会变得难维护。当前项目把 system prompt 拆成一组 pipe，核心在 [src/context/prompt-builder.ts](../src/context/prompt-builder.ts)：

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

一个 pipe 就是一个“可开关的 prompt 片段”。例如 [src/context/prompts.ts](../src/context/prompts.ts) 里的 `toolGuide`：

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
  .pipe('memoryContext', () => memoryStore.buildPromptSection())
  .pipe('ragContext', vectorStore ? ragContext(vectorStore) : () => null)
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

所以第三章引入两层压缩，代码在 [src/context/compressor.ts](../src/context/compressor.ts)。

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

当前 `compressor.ts` 是教学版压缩模块，单元测试和 E2E 会直接验证它的行为。`src/main.ts` 目前在线路上使用的是更轻量的三层防线 `applyDefense`，没有每轮都调用 LLM 摘要。这样做是刻意的：摘要会额外调用一次模型，适合作为“历史很长时的重型压缩”，而三层防线适合作为每轮都可以跑的便宜防护。

也就是说，当前代码里有两类能力：

- `microCompact` / `summarize`：教学版摘要压缩，重点讲清楚“如何把旧对话变成结构化摘要”。
- `applyDefense`：入口实际使用的在线防线，重点保证工具结果不会把上下文撑爆。

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

### 4. 三层防线：先防爆，再谈智能压缩

摘要压缩很有用，但它不是第一道防线。真实 Agent 最容易爆上下文的地方通常不是普通聊天，而是工具结果：

- `read_file` 一次读出超大文件
- `grep` 返回大量匹配
- `bash` 输出完整日志
- 多轮任务里旧工具结果一直留在 `messages`

所以当前入口在会话开始、每轮调用模型前、每轮调用模型后都会执行：

```ts
defendMessages(messages, timestamps, 'before-loop')

await agentLoop({ messages, ... })

defendMessages(messages, timestamps, 'after-loop')
```

`defendMessages` 内部调用 [src/context/defense.ts](../src/context/defense.ts) 里的 `applyDefense`：

```ts
export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  const trunc = truncateToolResults(messages)
  let result = trunc.messages

  const prune = ttlPrune(result, timestamps)
  result = prune.messages

  const estimatedTokens = estimateMessageTokens(result)

  return {
    messages: result,
    estimatedTokens,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  }
}
```

这里有三层思路。

第一层是 Token 估算。`estimateMessageTokens` 不追求 tokenizer 级别精确，而是把 `messages` 中的字符串、text part、tool output 都转成字符数，再用一个粗略比例估算：

```ts
// 4 chars per token, with 1.2x safety factor for Chinese
return Math.ceil((chars / 4) * 1.2)
```

为什么要先估算？因为 Context Engineering 需要一个“仪表盘”。即使估算不完美，也比完全不知道当前上下文有多大强得多。入口的 `/status` 和 `/context` 也依赖这些估算结果。

第二层是工具结果截断。`truncateToolResults` 做两件事：

1. 单条工具结果超过窗口 50% 时，做 Head / Tail 截断。
2. 所有消息总量超过窗口 75% 时，从最老的 tool result 开始 compact。

单条截断保留头尾：

```ts
const head = output.slice(0, Math.floor(config.maxSingleResult * 0.6))
const tail = output.slice(-Math.floor(config.maxSingleResult * 0.4))
```

这比直接砍掉尾部更适合代码和日志：文件头部常有 imports、配置、类型定义，尾部常有 exports、错误堆栈、最终结果。中间被删掉时，模型还能知道“这不是完整内容”。

第三层是 TTL 修剪。`ttlPrune` 给工具结果加时间意识：

- 5 分钟以上的旧工具结果进入 soft prune：保留头尾，中间删除
- 10 分钟以上的旧工具结果进入 hard prune：直接替换成过期占位符
- 包含 `error`、`失败`、`denied`、`timeout` 等错误信息的结果不修剪

错误结果要保留，是因为它们往往决定下一步策略。如果模型忘了“刚才为什么失败”，就容易重复同一个错误工具调用。

三层防线和摘要压缩的区别是：防线尽量不调用模型，成本低、可频繁执行；摘要压缩调用模型，语义保留更强，但成本更高。

### 5. `/context`、`/usage`、`/status`：把上下文变成可观察对象

Context Engineering 不能只停留在代码里。调试 Agent 时，必须能回答三个问题：

- 当前上下文大概用了多少？
- 是 system prompt、工具定义还是 messages 在吃窗口？
- prompt cache 有没有命中，省了多少钱？

入口提供了三个 slash command：

```text
/context
/usage
/status
```

这三个命令在 `src/main.ts` 的 readline 循环里被拦截，不会写入 `messages`，也不会触发模型调用。

`/context` 使用 [src/context/view.ts](../src/context/view.ts) 构造一个 `ContextSnapshot`，把窗口切成 16×16 的矩阵：

- System prompt
- System tools
- Memory
- Skills
- Messages
- Free space
- Autocompact buffer

它不是精确 tokenizer 视图，而是一个终端里的“上下文热力图”。你可以快速看出是工具定义太多，还是消息历史太长。

`/status` 是更轻量的数字版状态：

```text
消息数：0
消息 token 估算：~0
System prompt：3050 chars
工具：14 active，deferred ~4128 tokens，总计 ~4993 tokens
预算：0/200000 tokens (0%)
Usage：0 步，$0.0000，cache hit 0.0%
```

`/usage` 则专门展示 token 用量、cache 命中率和成本。它回答的是另一个问题：不只是“上下文有没有爆”，还有“这次运行花了多少钱”。

### 6. Prompt cache：不是自己缓存，而是读懂 provider 的 usage

很多模型服务会做 prompt cache：重复的 system prompt、工具定义、历史前缀如果命中缓存，输入 token 的计费会更低。这个项目没有手写一个本地 prompt cache；教学重点是学会从 provider 返回的 usage 里读出 cache 信息，并把它变成可观察的成本数据。

相关逻辑在 [src/usage/tracker.ts](../src/usage/tracker.ts)：

```ts
export interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}
```

AI SDK 和不同 provider 对 cache 字段的命名不完全一样，所以先用 `normalizeUsage` 统一成四类：

```ts
const cacheRead =
  usage.cachedInputTokens ??
  usage.providerMetadata?.openai?.cachedTokens ??
  0

const cacheWrite =
  usage.cacheCreationInputTokens ??
  usage.providerMetadata?.anthropic?.cacheCreationInputTokens ??
  0
```

这里有一个细节：OpenAI 风格的 `inputTokens` 往往已经包含 cached tokens，所以命中缓存后要把 cache read 从普通 input 里减出来：

```ts
let inputTokens = usage.inputTokens ?? 0
if (cacheRead && inputTokens >= cacheRead) inputTokens -= cacheRead
```

否则同一批 token 会被算两次，成本统计就会偏高。

`UsageTracker` 每一步记录一次模型调用：

```ts
tracker?.record(modelId, normalizeUsage(stepUsage))
```

然后 `totals()` 计算：

- 累计 input / output
- cache read / cache write
- cache hit rate
- 实际成本
- 假设没有 cache 时的 baseline cost
- cache 节省金额

这就是 `/usage` 视图里的信息来源。它让 prompt cache 从一个“服务商可能做了优化”的黑盒，变成可以观察、可以解释的工程指标。
