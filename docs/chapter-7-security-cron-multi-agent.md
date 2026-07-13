# 第七章：权限、Cron 和 Multi-Agent

前六章已经让 Agent 具备了工具、上下文、记忆、知识库和外部消息入口。但当 Agent 不再只响应终端里的一次提问，还会执行 shell、定时醒来、把任务交给其他 Agent 时，新的问题也随之出现：

- 哪些用户可以调用哪些工具？
- 高风险命令能不能在执行前被拦住？
- 没有人输入消息时，Agent 如何按计划工作？
- 一个复杂任务如何拆给多个独立上下文并行完成？

第七章加入三个运行时能力：

- 权限：用角色过滤工具，再用风险分类和 Hook 约束工具执行。
- Cron：把调度时间和 Agent Loop 接起来，让任务可以自动运行。
- Multi-Agent：把独立子任务交给子 Agent，并行收集结果。

它们分别回答“能不能做”“什么时候做”和“由谁来做”。

### 1. 角色权限：先决定模型能看到什么

最小角色模型在 [src/security/roles.ts](../src/security/roles.ts)：

```ts
export type Role = 'owner' | 'collaborator' | 'guest'

const TOOL_ACCESS = {
  owner: {
    allow: '*',
    deny: [],
  },
  collaborator: {
    allow: '*',
    deny: ['bash'],
  },
  guest: {
    allow: [
      'glob',
      'grep',
      'read_file',
      'rag_search',
      'calculator',
      'list_directory',
    ],
    deny: [],
  },
}
```

三个角色的意图很直接：

- `owner` 可以使用全部工具。
- `collaborator` 可以协作修改项目，但不能直接执行 `bash`。
- `guest` 只保留少量读取、检索和计算工具。

权限判断没有散落到各个工具的 `execute()` 里，而是进入 `ToolRegistry.getActiveTools()`：

```ts
getActiveTools() {
  return this.getAll().filter((tool) => {
    if (tool.profile && !tool.profile.includes(this.activeProfile)) {
      return false
    }
    if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
      return false
    }
    if (!canUseTool(this.currentRole, tool.name)) {
      return false
    }
    return true
  })
}
```

`toAISDKFormat()` 只会转换 active tools。因此，被角色禁止的工具不只是“执行时报错”，而是根本不会出现在本轮传给模型的 tools schema 中。

这比只在工具内部返回“没有权限”更好：

1. 模型不会反复尝试一个不可用的工具。
2. 不可用工具的 schema 不占 prompt token。
3. 权限边界集中在 registry，新增工具时不需要复制判断代码。

终端命令在 [src/commands/security.ts](../src/commands/security.ts)：

```text
/role
/role owner
/role collaborator
/role guest
```

例如切换到 guest 后，`getActiveTools()` 会立即按新角色重新计算可见工具。

当前 `/role` 是为了观察权限过滤效果而提供的教学开关，并不等于真实身份认证。生产系统应当从登录态或 Channel 的发送者身份推导角色，而不是允许用户通过命令自行切换成 `owner`。

### 2. Bash 风险分类：权限通过后还要检查动作

角色权限只能回答“能不能使用 bash”，不能回答“这条 bash 是否安全”。同一个工具里，`pwd` 和 `rm -rf` 的风险显然不同。

[src/security/bash-classifier.ts](../src/security/bash-classifier.ts) 把命令分成三级：

```ts
export type RiskLevel = 'safe' | 'moderate' | 'dangerous'
```

当前规则示例：

- `safe`：没有命中风险规则，正常执行。
- `moderate`：`rm`、`mv`、`kill`、`git push` 等，打印警告后执行。
- `dangerous`：`rm -rf`、`sudo`、`mkfs`、远程脚本管道执行等，直接拒绝。

风险判断在 [src/tools/tool-registry.ts](../src/tools/tool-registry.ts) 的工具包装层执行：

```ts
if (toolName === 'bash' && ipt?.command) {
  const risk = classifyBashCommand(ipt.command)
  if (risk.level === 'dangerous') {
    return `[拒绝执行 ${ipt.command}] 检测到危险操作: ${risk.reason}\n`
  }
  if (risk.level === 'moderate') {
    logger.warn(`[安全警告 ${ipt.command}] ${risk.reason}`)
  }
}
```

这里采用的是确定性规则，而不是再问一次模型“这条命令危险吗”。安全边界应该尽量由可测试、可审计的程序控制，不能把最终决定交回生成这条命令的模型。

正则分类器仍然只是教学版。真实 shell 语法还包括别名、变量展开、命令替换、编码和多段管道。生产环境通常还需要沙箱、工作目录限制、文件系统权限和人工审批，不能只依赖字符串匹配。

### 3. Hook Pipeline：在工具执行前后插入策略

角色表和 bash 分类器适合处理固定规则，但很多策略是项目相关的，例如：

- 文件写入前记录审计日志。
- 禁止写入某个目录。
- 自动清除工具输出里的敏感字段。
- 给命令输出附加时间戳。

如果这些逻辑全部写进 `ToolRegistry`，registry 很快会变成一个巨大的条件分支。[src/security/hooks.ts](../src/security/hooks.ts) 因此提供了 Hook Pipeline：

```ts
export type HookAction = 'allow' | 'block' | 'modify'

export interface HookResult {
  action: HookAction
  reason?: string
  modifiedInput?: unknown
  modifiedOutput?: unknown
}
```

Hook 分成两类：

- Pre-Tool Hook：工具执行前运行，可以允许、拦截或修改输入。
- Post-Tool Hook：工具执行后运行，可以修改模型最终看到的输出。

Pre Hook 会串行处理前一个 Hook 修改后的输入：

```ts
for (const hook of this.preHooks) {
  const result = await hook.fn(toolName, currentInput)
  if (result.action === 'block') return result
  if (result.action === 'modify' && result.modifiedInput !== undefined) {
    currentInput = result.modifiedInput
  }
}
```

项目在 [src/security/hook-instances/index.ts](../src/security/hook-instances/index.ts) 注册了两个示例：

- `audit-log`：在 `write_file` 或 `edit_file` 执行前记录目标路径。
- `bash-timestamp`：在 bash 输出前添加 ISO 时间戳。

入口把它们装配到同一条 pipeline：

```ts
const hookPipelines = new HookPipeline()
registeredPipelines.pre.forEach(({ name, pipeline }) =>
  hookPipelines.registerPre(name, pipeline),
)
registeredPipelines.post.forEach(({ name, pipeline }) =>
  hookPipelines.registerPost(name, pipeline),
)
toolRegistry.setHookPipeline(hookPipelines)
```

可以用 `/hooks` 查看当前注册的 Hook。

综合起来，一次普通工具调用的执行顺序是：

```text
角色过滤 → Bash 风险分类 → Pre Hooks → 获取工具锁
        → execute → 结果截断 → Post Hooks → 释放工具锁
```

每一层只解决一个问题：角色控制工具可见性，风险分类检查具体命令，Hook 承载可插拔策略，工具锁继续负责并发一致性。

### 4. Cron：让 Agent 在未来自动醒来

前面的 Channel 都由外部消息触发 Agent Loop。Cron 增加了另一种触发源：时间。

核心类型在 [src/cron/types.ts](../src/cron/types.ts)：

```ts
export interface CronJobConfig {
  id: string
  name: string
  schedule: string
  scheduleType: 'cron' | 'interval' | 'once'
  enabled: boolean
  payload: JobPayload
  timeout?: number
  maxRetries?: number
  source: 'config' | 'runtime'
}

export type JobPayload =
  | { type: 'agent'; prompt: string }
  | { type: 'handler'; handler: string }
```

调度和执行内容被刻意分开：

- `schedule` 决定什么时候运行。
- `payload` 决定到点以后运行什么。

当前 [src/cron/parser.ts](../src/cron/parser.ts) 支持三种时间表达方式：

```text
every 30s                 # 固定间隔
every 10m
every 2h
0 9 * * 1-5              # 五字段 cron 表达式
2026-07-15T09:00:00+08:00 # 一次性 ISO 时间
```

cron 表达式交给 `croner` 解析；固定间隔和一次性时间由本地 parser 识别。`CronService` 不使用 `setInterval()`，而是每次计算下一次延迟并设置一个 `setTimeout()`：

```ts
state.timerId = setTimeout(async () => {
  await this.executeJob(state)
  if (parsed.type !== 'once' && state.config.enabled && this.running) {
    this.scheduleJob(state)
  } else if (parsed.type === 'once') {
    this.remove(state.config.id)
  }
}, delayMs)
```

这样可以保证本次执行完成后再安排下一次；`state.running` 还会阻止同一个任务重入。一次性任务执行后会自动删除。

### 5. Cron 如何重新进入 Agent Loop

Cron 不应该自己实现一套“调用模型、执行工具、收集回复”的流程。它只依赖一个很小的执行器接口：

```ts
export interface CronExecutor {
  notify?: (message: string) => void
  runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>
}
```

入口 [src/index.ts](../src/index.ts) 负责把这个接口接回已有的 `agentLoop()`：

```ts
cronService.setExecutor({
  runAgentPrompt: async (prompt) => {
    const cronMessages: ModelMessage[] = [{ role: 'user', content: prompt }]
    const system = await builder.build(makePromptCtx())
    await agentLoop({
      model,
      budget,
      tracker,
      modelId,
      messages: cronMessages,
      system,
      tools: toolRegistry,
    })
    const lastMsg = cronMessages[cronMessages.length - 1]
    if (!lastMsg) return '(无输出)'
    if (typeof lastMsg.content === 'string') return lastMsg.content
    // 数组内容中只拼接 text part，省略无关 part
    return lastMsg.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  },
  notify: (message) => logger.info(`\n${message}`),
})
```

每次定时任务使用独立的 `cronMessages`，不会把后台任务写进终端主会话，但它仍然复用同一套 system prompt、ToolRegistry、预算和用量追踪。

执行完成后，[src/cron/store.ts](../src/cron/store.ts) 会把状态落到本地：

```text
.cron/
  jobs.json   # runtime 任务配置
  logs.jsonl  # 每次执行的结果
```

日志只保存最多 1000 字符的输出。任务连续失败达到 `maxRetries`（默认 3）后会自动禁用，避免一个坏任务永久消耗资源。

当前 `timeout` 已经是 `CronExecutor` 接口的一部分，但入口执行器还没有把它转换成 `AbortSignal` 传给 Agent Loop。因此它暂时是扩展点，不应把当前行为理解为已经具备强制超时中断。

### 6. cron_manage：让模型管理自己的计划

[src/tools/cron-tools.ts](../src/tools/cron-tools.ts) 把 CronService 包装成 `cron_manage` 工具，支持：

```text
list / add / remove / run / enable / disable / logs
```

例如用户说：

```text
每 30 分钟检查一次项目状态，有异常就给出摘要
```

模型可以调用：

```json
{
  "action": "add",
  "id": "project-health",
  "name": "项目状态检查",
  "schedule": "every 30m",
  "prompt": "检查当前项目状态，有异常时给出简短摘要"
}
```

这个工具被标记为不可并发、可写：

```ts
isConcurrencySafe: false,
isReadOnly: false,
```

因为新增和删除任务会修改 `.cron/jobs.json` 以及内存调度状态。

终端命令只提供面向人的只读观察入口：

```text
/cron
/cron list
/cron logs
```

新增、删除、启停和立即执行交给模型通过 `cron_manage` 完成。程序退出时会调用 `cronService.stop()` 清理所有 timer。

### 7. Multi-Agent：给子任务一个独立上下文

复杂任务经常包含多个互不依赖的部分。例如“分别检查安全、性能和测试覆盖，再汇总结论”。如果全部塞进父 Agent 的 messages：

- 中间工具结果会快速挤占上下文。
- 不同调查方向容易互相干扰。
- 本来可以并行的读取和搜索会被串行执行。

Multi-Agent 的核心不是“多一个人格”，而是“多一个隔离的任务上下文”。类型定义在 [src/agents/types.ts](../src/agents/types.ts)：

```ts
export interface SpawnRequest {
  task: string
  tools?: string[]
  timeout?: number
}

export interface SubAgentRun {
  id: string
  task: string
  status: 'running' | 'completed' | 'error' | 'timeout'
  depth: number
  startedAt: string
  finishedAt?: string
  result?: string
  error?: string
}
```

[src/tools/spawn-tools.ts](../src/tools/spawn-tools.ts) 注册了 `spawn_agent` 工具。它支持单任务和多任务两种输入：

```json
{ "task": "检查 src/security 的权限边界" }
```

```json
{
  "tasks": [
    "检查 src/security 的权限边界",
    "检查 src/cron 的调度与持久化",
    "检查 src/agents 的并发和超时"
  ]
}
```

多任务路径使用 `Promise.all()`：

```ts
const results = await Promise.all(
  requests.map(async (req, i) => {
    const result = await spawnAgent(req, ctx, i)
    return { task: req.task, result }
  }),
)
```

父 Agent 等待所有子 Agent 返回后，只把整理过的结果作为一次工具结果放回自己的上下文。每个子 Agent 的详细 messages 都留在自己的局部数组里。

### 8. 子 Agent 的循环、限制与锁问题

[src/agents/spawn.ts](../src/agents/spawn.ts) 为每个子 Agent 创建独立消息历史：

```ts
const messages: ModelMessage[] = [
  { role: 'user', content: request.task },
]
```

它继承父 Agent 当前的 system prompt，再追加一段子 Agent 说明。子 Agent 最多执行 30 step；最后一步强制 `toolChoice: 'none'`，要求模型停止调用工具并输出总结。

`SubAgentRegistry` 提供两道资源限制：

```ts
export const DEFAULT_CONFIG = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60_000,
}
```

- 最大深度避免子 Agent 无限递归派生。
- 最大并发避免一次请求创建过多模型调用。
- 每个任务还用 `AbortController` 控制执行时间。

当前子 Agent 的工具列表会排除 `spawn_agent`：

```ts
const EXCLUDED_TOOLS = new Set(['spawn_agent'])
```

所以教学版实际只允许父 Agent 派生一层，不允许子 Agent 再继续派生。

这里还有一个重要的并发细节：父 Agent 正在执行 `spawn_agent` 工具时，ToolRegistry 的独占锁尚未释放。如果子 Agent 再次通过普通 `toAISDKFormat()` 获取工具锁，就会等待父工具结束；而父工具又在等待子 Agent 返回，最终形成死锁。

因此子 Agent 使用：

```ts
ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS)
```

这个适配层绕过父 Agent 的读写锁，让子 Agent 可以在 `spawn_agent` 尚未返回时执行工具。代价是当前 unlocked 路径也没有运行 Bash 风险分类和 Hook Pipeline。它适合展示 Multi-Agent 的调用链，但生产实现应把“是否加锁”和“是否执行安全策略”拆成两个独立选项，不能因为避免死锁而一起跳过安全检查。

另外，`SpawnRequest.tools` 已经预留，但当前实现尚未按请求构造工具白名单；子 Agent 继承的是当前角色下的 active tools。这个字段同样属于后续扩展点。

### 9. 交互示例

查看和切换角色：

```text
You: /role
You: /role guest
You: /role owner
```

查看 Hook：

```text
You: /hooks
```

创建并观察定时任务：

```text
You: 每 10 分钟检查一次 README 是否和项目结构一致
You: /cron
You: /cron logs
```

让多个子 Agent 并行调查：

```text
You: 分别检查权限、Cron 和 Multi-Agent 的实现，然后汇总它们的边界
```

模型可以把三个方向放进一次 `spawn_agent.tasks` 调用。运行时会显示不同颜色的 `[Agent-1]`、`[Agent-2]`、`[Agent-3]` 日志。

查看子 Agent 运行记录：

```text
You: /agents
```

`/agents` 会显示任务 id、深度、状态、结果摘要，以及当前最大并发和最大深度配置。

### 10. 三种能力如何组合

这三部分不是彼此孤立的功能。一次自动化任务可能经过下面的完整路径：

```text
Cron 到点
  → 用独立 messages 启动父 Agent Loop
  → 当前角色过滤可用工具
  → 父 Agent 调用 spawn_agent 拆分调查任务
  → 多个子 Agent 并行读取和搜索
  → 父 Agent 汇总结果
  → Cron 写入运行日志并通知终端
```

权限负责收窄能力，Cron 负责触发，Multi-Agent 负责执行策略。它们最终仍然复用第一章的 Agent Loop 和第二章的 ToolRegistry，没有再造三套 Runtime。

### 11. 验证第七章能力

第七章目前没有独立的 E2E 脚本，默认回归测试仍然是：

```bash
bun test
```

手动验证时，可以按下面的顺序观察关键行为：

1. `/role guest` 后确认写文件、bash、cron 和 spawn 工具不再暴露给模型。
2. `/role owner` 后让 Agent 执行安全 bash，再尝试一条会命中危险规则的命令。
3. 用 `/hooks` 查看 pipeline，并执行 bash 观察输出时间戳。
4. 创建 `every 30s` 的短周期任务，用 `/cron` 和 `/cron logs` 观察状态。
5. 给出三个独立调查任务，再用 `/agents` 检查并发运行记录。

`.cron/` 是运行时数据，不应提交到 Git。

第七章完成后，这个教学项目从“会响应请求的 Agent”继续向“可约束、可调度、可协作的 Agent Runtime”迈进了一步：

- 角色、风险分类和 Hook 让工具执行有了策略边界。
- Cron 让 Agent 可以由时间驱动，而不只由消息驱动。
- Multi-Agent 让复杂任务可以隔离上下文并行处理。

它们仍然保持了项目一贯的原则：实现足够小，让关键机制能被直接读懂，同时把生产系统还需要补齐的边界明确留出来。
