# Agent 工具架构

`src/tools` 负责把本地能力、联网搜索能力和 MCP server 暴露的外部能力统一包装成 Agent 可以调用的工具。Agent Loop 不直接关心工具来自哪里，只依赖 `ToolRegistry` 输出的 AI SDK `tools` 对象。

## 目录职责

- `utility-tools.ts`：内置工具，例如读写文件、目录遍历、grep、bash、fetch、preview 等。
- `search-tools.ts`：联网搜索和网页抓取工具，目前支持 Tavily、Serper 和通用 URL 抓取。
- `tool-registry.ts`：工具注册中心，负责统一保存工具定义、转换 AI SDK 格式、执行并发控制、包装 MCP 工具、延迟激活工具。
- `tool-search.ts`：延迟工具发现工具。模型先调用 `tool_search` 获取某个延迟工具的完整定义，然后下一步才能真正调用该工具。

## 核心数据结构

所有工具先用 `ToolDefinition` 描述：

```ts
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  execute: (input: any) => Promise<unknown>

  isReadOnly?: boolean
  maxResultChars?: number
  isConcurrencySafe?: boolean

  shouldDefer?: boolean
  searchHint?: string
}
```

其中：

- `name` 是模型看到和调用的工具名。
- `description` 和 `parameters` 会传给模型，影响模型是否能正确选工具和填参数。
- `execute` 是真实执行逻辑。
- `isConcurrencySafe` 控制工具执行时使用共享锁还是独占锁。
- `maxResultChars` 控制工具返回给模型的最大文本长度，避免单次结果过大。
- `shouldDefer` 表示工具默认不直接暴露给模型。
- `searchHint` 用于 `tool_search` 在延迟工具列表中匹配工具。

## 启动注册流程

入口在 `src/index.ts`：

```ts
const toolRegistry = new ToolRegistry()
toolRegistry.register(...allTools)
toolRegistry.register(pickSearchTool(), webFetchTool)
toolRegistry.register(createToolSearchTool(toolRegistry))
```

启动时先注册内置工具、搜索工具和 `tool_search`。如果配置了 `GITHUB_PERSONAL_ACCESS_TOKEN`，`connectMCP()` 会启动 GitHub MCP server：

```ts
const client = new MCPClient(
  'bunx',
  ['-y', '@modelcontextprotocol/server-github'],
  { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
)

await toolRegistry.registerMCPServer('github', client)
```

`registerMCPServer()` 会：

1. 连接 MCP server。
2. 调用 `tools/list` 获取 MCP 工具列表。
3. 给每个 MCP 工具加前缀，例如 `search_repositories` 变成 `mcp__github__search_repositories`。
4. 把 MCP 工具包装成普通 `ToolDefinition`。
5. 默认把 MCP 工具标记为 `shouldDefer: true`，避免一次性把大量 schema 传给模型。

## Agent Loop 如何使用工具

Agent Loop 每一步调用 `streamText()`：

```ts
const result = streamText({
  model,
  system: system + tools.getDeferredToolSummary(),
  messages,
  maxRetries: 0,
  tools: tools.toAISDKFormat(),
})
```

这里有两个关键点：

- `tools.toAISDKFormat()` 只返回当前活跃工具。
- `tools.getDeferredToolSummary()` 把未激活的延迟工具名和搜索提示追加到 system prompt。

因此模型第一次只会看到内置工具、搜索工具和 `tool_search`。如果用户请求需要某个 MCP 工具，模型应先调用 `tool_search` 激活它；下一步 `toAISDKFormat()` 才会把该 MCP 工具真正暴露给模型。

典型流程：

```text
User: 搜索 MCP 相关的仓库
Step 1: 模型调用 tool_search({ query: "mcp__github__search_repositories" })
Step 2: ToolRegistry 把该工具加入 discoveredTools
Step 3: 下一轮 streamText 暴露 mcp__github__search_repositories
Step 4: 模型调用 mcp__github__search_repositories
Step 5: MCPClient 转发到 GitHub MCP server 并返回结果
```

## AI SDK 格式转换

`ToolRegistry.toAISDKFormat()` 把内部 `ToolDefinition` 转成 AI SDK 需要的工具对象：

```ts
result[name] = {
  description: tool.description,
  inputSchema: jsonSchema(tool.parameters),
  execute: async (input) => {
    // acquire lock
    // execute original tool
    // stringify and truncate result
    // release lock
  },
}
```

转换过程中会统一做三件事：

1. 用 `jsonSchema()` 包装参数 schema。
2. 按 `isConcurrencySafe` 做并发控制。
3. 把工具结果转成字符串并按 `maxResultChars` 截断。

这样每个具体工具只需要实现自己的业务逻辑，不需要重复处理 AI SDK 适配、锁和截断。

## 并发控制

`ToolRegistry` 内部实现了简单读写锁：

- `isConcurrencySafe: true` 的工具获取共享锁，可以和其他共享工具并发运行。
- `isConcurrencySafe: false` 或未声明的工具获取独占锁，需要等待所有共享工具结束，也会阻塞后续工具。

当前约定：

- 只读工具通常设置 `isConcurrencySafe: true`。
- 会修改文件、启动服务、执行 shell 的工具默认应保持串行。
- MCP GitHub 工具当前标记为只读和可并发；如果后续暴露写操作，需要按工具能力重新细分。

## 延迟工具发现

延迟工具的目标是减少模型上下文中的工具 schema 数量，并规避部分模型对大量复杂工具 schema 的不稳定支持。

状态由 `ToolRegistry.discoveredTools` 维护：

- `getActiveTools()` 返回所有非延迟工具，以及已经被发现的延迟工具。
- `getDeferredToolSummary()` 返回尚未发现的延迟工具摘要，追加到 system prompt。
- `searchTools(query)` 精确匹配工具名，或者在工具名、描述、`searchHint` 中做简单包含匹配。

`tool_search` 本身永远是活跃工具。它返回匹配工具的 `name`、`parameters` 和 `description`，同时把该工具加入 `discoveredTools`。

## MCP 工具包装

MCP 工具通过 `registerMCPServer(serverName, client)` 包装成本地工具：

```ts
{
  name: `mcp__${serverName}__${tool.name}`,
  description: `[MCP:${serverName}] ${tool.description}`,
  parameters: tool.inputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  shouldDefer: true,
  searchHint: `${serverName} ${tool.name} ${tool.description}`,
  execute: async (input) => client.callTool(originalName, input),
}
```

这层包装让 Agent Loop 不需要理解 MCP 协议。对 Agent 来说，MCP 工具和本地工具都是普通 `ToolDefinition`；只有 `execute` 内部会把调用转发给 MCP server。

## 添加新工具

添加普通工具：

1. 在 `utility-tools.ts` 或新的工具文件中创建 `ToolDefinition`。
2. 写清楚 `description` 和 JSON Schema `parameters`。
3. 根据副作用设置 `isReadOnly` 和 `isConcurrencySafe`。
4. 在 `src/index.ts` 注册到 `toolRegistry`。

添加 MCP server：

1. 创建 `MCPClient`，指定启动命令、参数和环境变量。
2. 调用 `toolRegistry.registerMCPServer(name, client)`。
3. 确认工具名前缀和 system prompt 能引导模型先用 `tool_search` 激活工具。

## 调试要点

- 如果模型完全没有输出，先看 `agent/loop.ts` 中 `[AI SDK stream error]` 打印的 provider 错误。
- 如果模型不知道某个 MCP 工具，确认 `getDeferredToolSummary()` 是否包含该工具。
- 如果 `tool_search` 找不到工具，检查工具名、描述和 `searchHint`。
- 如果工具返回内容太短，检查 `maxResultChars` 是否截断。
- 如果工具执行互相阻塞，检查 `isConcurrencySafe` 设置是否过保守。
