# 第六章：Skills、Plugins 和 Channels

前五章里的 Agent 还是一个“本地终端程序”：用户在 readline 里输入，Agent 在同一个进程里调用工具、读写记忆、检索 RAG。

第六章开始把它拆成三个更接近真实产品的扩展点：

- Skill：把一套任务方法论临时注入 prompt。
- Plugin：把外部能力注册进 Agent，比如工具或消息通道。
- Channel：把 Agent Loop 接到终端之外的消息入口，比如飞书。

这三者解决的问题不同。Skill 改的是“模型应该怎么做事”，Plugin 改的是“Agent 有哪些能力”，Channel 改的是“用户从哪里和 Agent 对话”。

### 1. Skill：可开关的任务说明书

Skill 的实现很轻，核心代码在 [src/skills/loader.ts](../src/skills/loader.ts)。它只扫描项目根目录下的 `.skills/`：

```text
.skills/
  code-review/
    SKILL.md
```

每个 `SKILL.md` 可以带 frontmatter：

```md
---
name: code-review
description: "以高级工程师视角审查项目代码"
---

# Code Review

先确定审查范围，再逐文件阅读，最后按 P0/P1/P2 输出发现。
```

`SkillLoader.load()` 启动时读取这些文件，保存成内存里的 `SkillDefinition`：

```ts
this.skills.set(entry.name, {
  name: entry.name,
  content: parsed.content,
  description: parsed.description,
  dirPath: path.join(skillsDir, entry.name),
})
```

注意：当前教学版没有做复杂的触发规则或自动路由。Skill 是否生效，由一个 `activeSkills` 集合控制：

```ts
const skillLoader = new SkillLoader('.')
const activeSkills = new Set<string>()
```

入口 [src/index.ts](../src/index.ts) 会把它接进 PromptBuilder：

```ts
const builder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', () => memoryStore.buildPromptSection())
  .pipe('ragContext', vectorStore ? ragContext(vectorStore) : () => null)
  .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
  .pipe('sessionContext', sessionContext())
```

`buildPromptSection()` 会做两件事：

1. 把已激活 skill 的完整内容放进 system prompt。
2. 把未激活 skill 的名称和描述列出来，提醒用户可以用命令激活。

也就是说，Skill 本质上不是工具，不会出现在 `tools` 参数里；它是一个可开关的 prompt 片段。

### 2. Skill 命令：人类控制 prompt 注入

命令实现在 [src/commands/skills.ts](../src/commands/skills.ts)：

```text
/skill
/skill list
/skill load <name>
/skill unload <name>
/<skill-name> <用户指令>
```

前三个命令只管理 `activeSkills`：

```ts
activeSkills.add(name)
activeSkills.delete(name)
```

更有意思的是最后一种形式：

```text
/code-review src/tools
```

如果 `/code-review` 对应一个 skill，命令处理器会：

1. 激活这个 skill。
2. 把 skill 内容和用户指令拼成一条新的 user message。
3. 直接调用 `agentLoop()`。
4. 把新增消息追加写入 session。

关键代码是：

```ts
const content = args
  ? `${skill.content}\n\n用户指令: ${args}`
  : skill.content

const userMsg: ModelMessage = { role: 'user', content }
ctx.messages.push(userMsg)
ctx.sessionStore.append(userMsg)

const currentSystem = await ctx.builder.build(ctx.makePromptCtx())
agentLoop({
  model: ctx.model,
  messages: ctx.messages,
  system: currentSystem,
  tools: ctx.registry,
})
```

这让 Skill 同时支持两种用法：

- 长期开启：`/skill load code-review`，后续多轮对话都带着这份方法论。
- 立即执行：`/code-review src/tools`，像一个本地命令一样触发任务。

### 3. Plugin：受控的能力扩展点

Plugin 的类型定义在 [src/plugins/types.ts](../src/plugins/types.ts)：

```ts
export interface PluginDefinition {
  name: string
  version: string
  description: string
  config?: PluginConfig
  destroy?(): Promise<void> | void
  activate(api: PluginApi): Promise<void> | void
}
```

插件真正拿到的不是完整 `ToolRegistry` 或 `ChannelGateway`，而是一个受控的 `PluginApi`：

```ts
export interface PluginApi {
  getConfig(): PluginConfig
  log(message: string): void
  registerTools(tools: ToolDefinition[]): void
  registerChannel(channel: ChannelDefinition): void
}
```

这里有一个重要边界：插件只能注册工具和通道，不能直接拿到 registry 去删除其他工具，也不能直接操作 Agent 的内部消息数组。

[src/plugins/manager.ts](../src/plugins/manager.ts) 负责加载和卸载插件。加载时它会：

1. 合并插件默认配置和外部传入配置。
2. 解析 `${ENV_NAME}` 形式的环境变量。
3. 构造受控 `api`。
4. 调用 `definition.activate(api)`。
5. 记录这个插件注册过哪些 tool 和 channel。

```ts
const resolvedConfig = this.resolveEnvVars({
  ...definition.config,
  ...config,
})

const registeredTools: string[] = []
const registeredChannels: string[] = []

const api: PluginApi = {
  registerTools: (tools) => {
    this.registry.register(...tools)
    registeredTools.push(...tools.map((tool) => tool.name))
  },
  registerChannel: (channel) => {
    this.channelGateway.register(channel)
    registeredChannels.push(channel.name)
  },
  getConfig: () => resolvedConfig,
  log: (message) => logger.raw(...),
}
```

卸载时则反向清理：

```ts
for (const toolName of plugin.tools) {
  this.registry.unregister(toolName)
}

for (const channelName of plugin.channels) {
  await this.channelGateway.unregister(channelName)
}
```

这就是插件系统最小可用的生命周期：`activate` 注册能力，`destroy` 释放资源，manager 负责登记和回收。

### 4. Plugin 命令：动态加载和卸载能力

终端命令在 [src/commands/plugin.ts](../src/commands/plugin.ts)：

```text
/plugin
/plugin list
/plugin load <name>
/plugin unload <name>
```

入口里先准备可用插件列表：

```ts
const pluginManager = new PluginManager(toolRegistry)
const feishuPlugin = createFeishuPlugin()
const availablePlugins = new Map<string, PluginDefinition>([
  [feishuPlugin.name, feishuPlugin],
])
```

然后把命令注册到 dispatcher：

```ts
...createPluginCommands(pluginManager, availablePlugins)
```

当前项目里的示例插件是 `feishu`。入口启动时会默认加载它：

```ts
pluginManager.setChannelGateway(gateway)
await pluginManager.load(feishuPlugin)
await gateway.startAll()
```

所以 `/plugin list` 会显示它已经加载。教学重点不在飞书本身，而在这个扩展路径：任何新插件只要实现 `PluginDefinition`，就可以把工具或消息通道挂到同一个 Agent Runtime 上。

### 5. Channel：把外部消息转成 Agent Loop 输入

Channel 的类型定义在 [src/channels/types.ts](../src/channels/types.ts)：

```ts
export interface ChannelDefinition {
  name: string
  description: string

  start(): Promise<void> | void
  stop(): Promise<void> | void
  send(message: OutgoingMessage): Promise<void>
  onMessage?: (handler: (msg: IncomingMessage) => void) => void
}
```

它只抽象四件事：

- `start`：启动通道，例如开启 WebSocket 或 HTTP server。
- `stop`：停止通道。
- `onMessage`：把外部消息交给 Agent。
- `send`：把 Agent 回复发回外部系统。

真正把 Channel 和 Agent Loop 接起来的是 [src/channels/gateway.ts](../src/channels/gateway.ts)。

注册通道时，Gateway 会把自己的 `handleIncoming()` 绑到 channel 上：

```ts
channel.onMessage?.((msg: IncomingMessage) => {
  void this.handleIncoming(channel.name, msg)
})
```

收到外部消息后，流程是：

1. 用 `channelName:senderId` 作为会话 key。
2. 为这个外部用户维护独立的 `messages` 数组。
3. 把外部消息转成 `{ role: 'user', content: msg.text }`。
4. 重新构建 system prompt。
5. 调用同一个 `agentLoop()`。
6. 从最后一条 assistant message 里抽取文本。
7. 调用 channel 的 `send()` 发回去。

核心代码：

```ts
const sessionKey = `${channelName}:${msg.senderId}`
const messages = this.sessions.get(sessionKey)!
messages.push({ role: 'user', content: msg.text })

const system = await this.options.buildSystem()
await agentLoop({
  system,
  messages,
  budget: this.budget,
  model: this.options.model,
  tools: this.options.registry,
})

await channel.send({
  text: replyText,
  channelId: msg.channelId,
  recipientId: msg.senderId,
})
```

这说明 Channel 没有复制一套 Agent 逻辑。终端、飞书、Dashboard 测试入口，本质上都在复用同一个 Agent Loop 和同一个 ToolRegistry。

### 6. 飞书插件：一个真实 Channel 示例

飞书示例在 [src/channels/adapters/feishu.ts](../src/channels/adapters/feishu.ts)。它同时展示了 Plugin 和 Channel 如何组合：

```ts
export function createFeishuPlugin(): PluginDefinition {
  return {
    name: 'feishu',
    version: '1.0.0',
    description: '飞书 Bot 消息通道插件',
    config: {
      port: '${FEISHU_PORT}',
      appId: '${FEISHU_APP_ID}',
      appSecret: '${FEISHU_APP_SECRET}',
    },
    activate(api) {
      const config = api.getConfig()
      api.registerChannel(
        new FeishuChannel({
          port,
          appId: String(config.appId || ''),
          appSecret: String(config.appSecret || ''),
        }),
      )
    },
  }
}
```

`FeishuChannel.start()` 里有两条路径：

- 总是启动一个本地 Dashboard，默认端口是 `3000`。
- 如果配置了 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，再启动飞书长连接。

没有飞书凭证时，也可以用 Dashboard 或 webhook 模拟消息：

```bash
bun run dev
```

然后打开：

```text
http://localhost:3000
```

页面上的“发送测试消息”会走 `/webhook/feishu`，最终仍然进入 `ChannelGateway.handleIncoming()`。

配置真实飞书时：

```bash
FEISHU_PORT=3000 \
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
bun run dev
```

### 7. 交互示例

查看 Skill：

```text
You: /skill
```

激活代码审查 Skill：

```text
You: /skill load code-review
```

直接触发 Skill：

```text
You: /code-review src/tools
```

查看插件：

```text
You: /plugin
```

查看已注册通道：

```text
You: /channel
```

启动后如果没有配置飞书凭证，终端会提示 Dashboard 地址。通过页面发送测试消息后，能在终端看到类似日志：

```text
[gateway:feishu:in] web-dashboard(web-dashboard): 你好
[gateway:feishu:out] ...
```

### 8. 第六章的测试

插件和通道的 E2E 在 [e2e/plugins.e2e.ts](../e2e/plugins.e2e.ts)：

```bash
bun run test:e2e:plugins
```

它覆盖两条关键路径：

- 插件可以注册工具，工具能出现在 `ToolRegistry.toAISDKFormat()` 里并被执行，卸载后工具会被移除。
- 插件可以注册 Channel，卸载插件时对应 Channel 也会从 Gateway 移除。

默认测试仍然可以直接跑：

```bash
bun test
```

第六章完成后，这个教学项目已经具备一个小型 Agent Runtime 的基本结构：

- Agent Loop 负责思考和行动。
- Tool System 负责能力暴露和执行控制。
- Context Engineering 负责上下文预算。
- Memory 和 RAG 负责长期信息。
- Skills 负责任务方法论。
- Plugins 负责能力扩展。
- Channels 负责多入口对话。
