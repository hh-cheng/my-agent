# 第八章：配置系统与 CLI 入口

前七章不断给 Agent 增加能力：模型、工具、Memory、RAG、Plugin、Channel、
Cron 和 Multi-Agent 都已经进入同一个 Runtime。

如果这些模块继续在入口里写死参数，项目很快会遇到三个问题：

- 换模型、端口或数据目录都要改 TypeScript。
- 本地开发、测试和部署环境无法共享同一套启动逻辑。
- API Key 容易混进源码或配置文件，增加泄露风险。

第八章增加一个很小的配置系统，并把原来的单文件入口拆成两层：

- `src/index.ts`：只负责判断 CLI 命令。
- `src/main.ts`：读取配置并装配 Agent Runtime。

配置系统也拆成三个职责明确的文件：

- `schema.ts` 定义配置形状、约束和默认值。
- `loader.ts` 读取 JSON、替换环境变量并校验。
- `init.ts` 通过交互式向导生成配置和 `.env`。

最终的启动流程是：

```text
bun run init
  → index.ts 识别 init
  → runInit()
  → 生成 super-agent.config.json 和可选的 .env

bun run dev
  → index.ts 进入默认分支
  → startAgent()
  → loadConfig()
  → 按配置装配模型、工具和运行时模块
```

### 1. 为什么配置也需要 schema

直接读取 JSON 很简单：

```ts
const config = JSON.parse(fs.readFileSync('super-agent.config.json', 'utf8'))
```

但 TypeScript 类型只在编译时存在。用户完全可以在 JSON 里写出：

```json
{
  "agents": {
    "maxConcurrent": -100
  }
}
```

如果没有运行时校验，这个错误会一直传到 `SubAgentRegistry`，最终以更难定位的
方式表现出来。

[src/config/schema.ts](../src/config/schema.ts) 使用 Zod 同时提供：

1. 运行时数据校验。
2. 缺省字段的默认值。
3. 从 schema 推导出的 TypeScript 类型。

以 Agent 配置为例：

```ts
export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().positive().default(60000),
  budgetLimit: z.number().positive().default(200000),
})
```

这里不只描述字段类型，还把运行时边界写进了配置协议：

- 子 Agent 嵌套深度只能是 `0–5`。
- 最大并发只能是 `1–10`。
- 超时和 token 预算必须是正数。

顶层配置由各个子 schema 组合：

```ts
export const SuperAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.prefault({}),
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.prefault({}),
  agents: AgentConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
  rag: RagConfigSchema.prefault({}),
  cron: CronConfigSchema.prefault({}),
  session: SessionConfigSchema.prefault({}),
  usage: UsageConfigSchema.prefault({}),
})

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>
```

运行时代码不再手写另一份 `SuperAgentConfig` interface，避免“类型定义已经更新，
校验逻辑却忘记同步”。

### 2. `prefault({})`：让嵌套默认值真正执行

Zod 4 里，下面的写法会报类型错误：

```ts
model: ModelConfigSchema.default({})
```

原因是 `.default()` 接收的是 schema 的输出值。`ModelConfigSchema` 解析后的对象必须
包含 `provider`、`name`、`baseURL` 和 `apiKey`，所以空对象不是合法的输出。

这里真正想表达的是：“字段缺失时，先拿空对象作为输入，再让子字段补默认值”。
对应 API 是：

```ts
model: ModelConfigSchema.prefault({})
```

两者的差异可以概括为：

```text
default  → 缺失时直接返回完整默认输出
prefault → 缺失时把默认输入送进 schema 继续解析
```

因此：

```ts
SuperAgentConfigSchema.parse({})
```

可以得到一份完整配置，而不用在顶层重复写所有嵌套字段的默认值。

### 3. loader：读取、替换、校验

[src/config/loader.ts](../src/config/loader.ts) 的加载顺序是：

```text
检查文件是否存在
  → 读取 JSON
  → 递归替换 ${ENV_NAME}
  → safeParse 校验
  → 返回 SuperAgentConfig
```

配置文件不存在时，程序不会直接失败，而是使用 schema 默认值：

```ts
if (!fs.existsSync(path)) {
  logger.info(`未找到 ${path}，使用默认配置`)
  logger.info('运行 bun run init 生成配置文件\n')
  return SuperAgentConfigSchema.parse({})
}
```

这保留了项目原来的低门槛体验：第一次克隆项目后可以直接 `bun run dev`，没有模型
凭证时继续使用本地 mock model。

JSON 解析和 schema 校验是两类不同错误：

- JSON 解析失败说明文件语法有问题，例如少了逗号。
- schema 校验失败说明 JSON 合法，但字段值不符合配置协议。

schema 校验失败时会逐条打印路径：

```ts
const result = SuperAgentConfigSchema.safeParse(substituted)
if (!result.success) {
  logger.error('✗ 配置文件校验失败:')
  for (const issue of result.error.issues) {
    logger.error(`    ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}
```

相比直接抛出一大段 ZodError，这种输出更适合 CLI 用户修改 JSON。

### 4. 环境变量占位符：配置结构和秘密分开保存

配置文件需要描述“API Key 从哪里来”，但不应该保存真实 Key。因此配置里写的是：

```json
{
  "model": {
    "apiKey": "${DEEPSEEK_API_KEY}"
  }
}
```

loader 会递归遍历字符串、数组和对象：

```ts
const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g

function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_VAR_RE, (match, name) => {
      const val = process.env[name]
      if (val === undefined) {
        logger.warn(`⚠ 环境变量 ${name} 未设置，保留原值`)
        return match
      }
      return val
    })
  }

  if (Array.isArray(obj)) return obj.map(substituteEnvVars)
  // 对象继续递归，其他原始值直接返回
}
```

环境变量不存在时保留原占位符，而不是替换成空字符串。这样日志里能看出具体缺少哪个
变量；模型初始化还会识别未解析的 `${...}`，并回退到 mock model。

环境变量替换发生在 schema 校验前。因此替换后的值仍然要通过字段类型和约束，环境变量
不是绕过配置校验的后门。

### 5. init：用向导生成一份可加载的配置

手写 JSON 容易漏字段，也容易把 Key 放错位置。[src/config/init.ts](../src/config/init.ts)
提供了一个 readline 向导：

```bash
bun run init
```

当前向导依次询问：

1. 已有配置是否覆盖。
2. 使用哪个 DeepSeek 模型。
3. 是否输入 `DEEPSEEK_API_KEY`。
4. 是否启用飞书 Channel。
5. 飞书 App ID 和 App Secret。
6. 子 Agent 最大并发数。

向导不是直接拼一段未经检查的 JSON，而是先调用同一个 schema：

```ts
const config = SuperAgentConfigSchema.parse({
  version: '1.0',
  model: {
    provider: 'deepseek',
    name: modelName,
    baseURL: 'https://api.deepseek.com',
    apiKey: '${DEEPSEEK_API_KEY}',
  },
  // 其他模块配置
})

fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
```

这形成一个很重要的闭环：生成配置和读取配置使用同一个 schema。以后 schema 增加必填
约束时，init 也会立即暴露不一致，而不是生成一个程序自己都读不了的文件。

### 6. `.env` 更新不能破坏用户已有内容

一个危险但常见的实现是：

```ts
fs.writeFileSync('.env', `DEEPSEEK_API_KEY=${apiKey}\n`)
```

这会删除 `.env` 里已经存在的搜索、Embedding、GitHub MCP 等凭证。

当前 `writeEnvVariables()` 会先读取已有文件，再按变量名更新或追加目标行：

```ts
for (const [name, value] of Object.entries(values)) {
  const assignment = `${name}=${JSON.stringify(value)}`
  const index = lines.findIndex((line) =>
    new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line),
  )

  if (index >= 0) lines[index] = assignment
  else lines.push(assignment)
}
```

`JSON.stringify(value)` 会给值加引号，避免空格或 `#` 被 dotenv 当成语法。没有在向导中
输入 Key 时，不会写入对应变量，运行时仍可以使用用户原来设置的环境变量。

真实秘密只进入 `.env`，生成的 `super-agent.config.json` 始终保留占位符。这两个文件都
属于本地配置，不应提交到 Git；项目已经忽略它们。

### 7. CLI 入口只做分发，不装配 Runtime

原来的 [src/index.ts](../src/index.ts) 同时做了所有事情：创建模型、注册工具、连接 MCP、
启动 Channel、创建 readline。这样一来，即使只想运行初始化向导，也可能顺带初始化
数据库或外部服务。

现在入口缩小到十几行：

```ts
const command = process.argv[2]

function reportStartupError(error: unknown) {
  console.error(error)
  process.exitCode = 1
}

if (command === 'init') {
  import('./config/init.js')
    .then((module) => module.runInit())
    .catch(reportStartupError)
} else {
  import('./main.js')
    .then((module) => module.startAgent())
    .catch(reportStartupError)
}
```

这里使用动态 `import()` 有两个作用：

1. `init` 分支不会加载庞大的 Agent Runtime。
2. 默认分支不会执行初始化向导模块里的交互逻辑。

两条 Promise 链最终都进入 `reportStartupError()`，动态导入失败和函数内部异常不会变成
无人处理的 Promise rejection。

`package.json` 把 CLI 参数包装成容易记忆的脚本：

```json
{
  "scripts": {
    "dev": "bun src/index.ts",
    "init": "bun src/index.ts init",
    "continue": "bun src/index.ts --continue"
  }
}
```

`--continue` 不是顶层子命令，所以会进入默认分支；`startAgent()` 再通过
`process.argv.includes('--continue')` 决定是否恢复 Session。

### 8. main：配置驱动的 Runtime 装配层

[src/main.ts](../src/main.ts) 导出：

```ts
export async function startAgent() {
  // 初始化 Memory、MCP、Session、Channel、Cron 和 readline
}
```

文件顶部先加载配置，再创建共享模块。当前主要映射关系如下：

| 配置字段 | Runtime 使用位置 |
| --- | --- |
| `model.*` | DeepSeek、OpenAI、自定义兼容模型或 mock model |
| `agents.*` | 子 Agent 深度、并发、超时和共享预算 |
| `channels.feishu.*` | 飞书插件开关、凭证和 Dashboard 端口 |
| `security.*` | 默认角色、审计 Hook、Bash 时间戳 Hook |
| `memory.dataDir` | `MemoryStore` 数据根目录 |
| `rag.*` | RAG 开关、文档目录和 SQLite 文件位置 |
| `cron.*` | Cron 开关和持久化目录 |
| `session.id` | 默认 Session 文件名 |
| `usage.trackingFile` | token 与成本 JSONL 文件 |
| `plugins` | 启动时自动加载的已知插件 |

配置系统的价值不只是“能读取 JSON”，而是这些参数真正进入了对应构造函数。比如：

```ts
const memoryStore = new MemoryStore(config.memory.dataDir)
const cronService = new CronService(config.cron.dataDir)

const agentRegistry = new SubAgentRegistry({
  maxSpawnDepth: config.agents.maxSpawnDepth,
  maxConcurrent: config.agents.maxConcurrent,
  defaultTimeout: config.agents.defaultTimeout,
})
```

如果 schema 有字段，但 Runtime 仍然写死常量，这个字段只是“看起来可以配置”。配置审计
时应该逐个检查 schema 字段是否有真实消费者。

### 9. 模型配置：没有凭证时保留 mock 回退

模型创建会先读取已经替换过的 `config.model.apiKey`。如果它还是 `${...}`，说明对应环境
变量不存在；程序继续尝试 provider 的常用环境变量，仍然没有时使用 mock model：

```ts
const apiKey = getModelApiKey()
const model = (() => {
  if (!apiKey) return createMockModel()

  const providerOptions = {
    apiKey,
    baseURL: config.model.baseURL || undefined,
  }

  if (config.model.provider === 'deepseek') {
    return createDeepSeek(providerOptions).chat(config.model.name)
  }

  return createOpenAI(providerOptions).chat(config.model.name)
})()
```

`openai` 和 `custom` 都复用 OpenAI-compatible provider；自定义服务通过 `baseURL` 指向
兼容接口。教学版 init 只引导 DeepSeek，OpenAI 和自定义 provider 可以手动编辑配置。

这里保留 mock 回退很重要。配置系统不应该让原来“无 Key 也能运行”的本地教学体验退化。

### 10. 飞书和插件：开关应该控制生命周期

飞书以前在入口中无条件加载，即使没有凭证也会启动 Dashboard。现在只有明确启用时才
加载：

```ts
pluginManager.setChannelGateway(gateway)

if (config.channels.feishu.enabled) {
  await pluginManager.load(feishuPlugin, config.channels.feishu)
}

await gateway.startAll()
```

这里仍然通过 `PluginManager`，而不是绕过插件直接 new `FeishuChannel`。这样既能把配置
传给 Channel，又保留插件的注册记录、卸载和资源回收能力。

通用插件配置也会在启动时处理：

```ts
for (const pluginConfig of config.plugins) {
  if (!pluginConfig.enabled || loadedPlugins.has(pluginConfig.name)) continue

  const definition = availablePlugins.get(pluginConfig.name)
  if (!definition) {
    logger.warn(`配置的插件不存在，已跳过: ${pluginConfig.name}`)
    continue
  }

  await pluginManager.load(definition, pluginConfig.config)
}
```

配置只能启用 `availablePlugins` 里已经登记的插件。JSON 不能凭空加载任意代码，这也是一
条必要的安全边界。

### 11. 共享预算：配置不只是构造参数

如果终端 Agent 和 Channel Gateway 各自创建预算：

```ts
const budget = { used: 0, limit: 200_000 }
// Gateway 内部又创建另一份 budget
```

那么同一个进程会出现两套互不知情的计数，`budgetLimit` 无法表达真正的全局上限。

现在先按配置创建一个由调用方持有的对象：

```ts
const budget: BudgetState = {
  used: 0,
  limit: config.agents.budgetLimit,
}
```

然后把同一个引用传给终端对话、Cron 和 Channel Gateway：

```ts
const gateway = new ChannelGateway({
  model,
  budget,
  registry: toolRegistry,
  buildSystem: () => builder.build(makePromptCtx()),
})
```

配置驱动不仅是“把 `3` 换成 `config.xxx`”，还要确认状态的所有消费者是否共享同一个
语义。共享预算就是一个典型例子。

### 12. RAG 路径也要服从配置

RAG 配置包含三个字段：

```json
{
  "rag": {
    "enabled": true,
    "docsDir": "docs",
    "databasePath": "knowledge.db"
  }
}
```

只有 `enabled` 为 true 且存在 `EMBED_API_KEY` 时才注册 RAG：

```ts
const ragEnabled = config.rag.enabled && Boolean(process.env.EMBED_API_KEY)
const vectorStore = ragEnabled
  ? new SqliteVectorStore(config.rag.databasePath)
  : null
```

`docsDir` 传给 `createRagTools()`。`rag_ingest` 收到绝对路径时原样使用；收到相对路径时
基于 `docsDir` 解析：

```ts
const resolvedPath = path.isAbsolute(documentPath)
  ? documentPath
  : path.join(docsDir, documentPath)
```

这不会在启动时自动导入整个目录。显式调用 `rag_ingest` 的设计仍然保留，只是工具输入
的相对路径现在统一基于配置的文档根目录解释。

### 13. 一份生成配置示例

运行 `bun run init` 后，配置大致如下：

```json
{
  "version": "1.0",
  "model": {
    "provider": "deepseek",
    "name": "deepseek-v4-pro",
    "baseURL": "https://api.deepseek.com",
    "apiKey": "${DEEPSEEK_API_KEY}"
  },
  "plugins": [],
  "channels": {
    "feishu": {
      "enabled": false,
      "appId": "",
      "appSecret": "",
      "port": 3000
    }
  },
  "agents": {
    "maxSpawnDepth": 1,
    "maxConcurrent": 3,
    "defaultTimeout": 60000,
    "budgetLimit": 200000
  },
  "security": {
    "defaultRole": "owner",
    "auditLog": true,
    "bashTimestamp": true
  },
  "memory": { "dataDir": "." },
  "rag": {
    "enabled": true,
    "docsDir": "docs",
    "databasePath": "knowledge.db"
  },
  "cron": { "enabled": true, "dataDir": "." },
  "session": { "id": "default" },
  "usage": { "trackingFile": ".usage/today.jsonl" }
}
```

如果不运行 init，schema 也会产生完整默认结构；其中模型名称使用 schema 默认的
`deepseek-v4-flash`。init 则允许用户交互选择，并帮助更新 `.env`。

### 14. 验证配置和 CLI

先运行初始化向导：

```bash
bun run init
```

确认生成的配置没有真实秘密，再启动 Agent：

```bash
bun run dev
```

可以用下面几组修改观察配置是否真正生效：

1. 把 `session.id` 改成 `chapter-8`，确认 Session 文件名变化。
2. 把 `agents.maxConcurrent` 改成 `1`，用 `/agents` 查看限制。
3. 把 `security.defaultRole` 改成 `guest`，确认可见工具减少。
4. 把 `cron.enabled` 改成 `false`，确认 Cron 不启动调度。
5. 启用 `channels.feishu.enabled`，确认飞书 Channel 和 Dashboard 才开始注册。
6. 把 `agents.maxConcurrent` 改成 `100`，确认 loader 给出 schema 错误并退出。

自动验证仍然包括：

```bash
bunx biome check src/index.ts src/main.ts src/config/*.ts
bunx tsc --noEmit
bun test
bun run test:e2e:rag
```

RAG E2E 的真实 Embedding 用例需要网络和 `EMBED_API_KEY`；没有外部凭证时，至少应运行
其中使用 fake embedder 的本地路径。

### 15. 当前边界与后续实验

当前配置系统刻意保持简单，还有几个明确边界：

- `version` 只是元数据，还没有配置迁移器。
- loader 校验失败会直接 `process.exit(1)`，不适合被长驻服务作为库调用。
- init 当前只提供 DeepSeek 向导，其他 provider 需要手动编辑。
- 插件必须先进入 `availablePlugins`，配置文件不负责动态发现代码。
- 配置修改后需要重启，没有文件监听或热更新。
- 相对数据目录仍然基于进程工作目录解析；部署时可以改用绝对路径。
- `.env` 是本地开发方案，生产环境应使用部署平台的 Secret Manager。
- 配置 schema 只保证结构正确，不能验证远端 API Key 是否真的可用。

可以继续做这些实验：

1. 根据 `version` 编写 `1.0 → 1.1` 配置迁移。
2. 给 init 增加 OpenAI 和自定义 provider 分支。
3. 为配置加载器增加单元测试，并让错误以 Result 返回而不是退出进程。
4. 增加 `--config <path>`，支持多环境配置文件。
5. 增加 `config print` 命令，输出隐藏秘密后的最终生效配置。
6. 把 schema 自动转换成 JSON Schema，供编辑器提示和外部工具使用。

第八章完成后，这个项目的启动边界更加清晰：

- CLI 入口只决定“运行哪个命令”。
- init 负责“生成什么配置”。
- loader 负责“配置是否合法”。
- main 负责“怎样按配置装配 Runtime”。

这种拆分没有引入庞大的配置框架，但已经解决了教学项目继续增长时最重要的问题：参数
有唯一协议，秘密与结构分离，启动命令不会误触发无关模块，而配置字段也真正进入了运行
时对象。
