# Agent 接入 MCP 原理

MCP（Model Context Protocol）把外部能力抽象成统一的工具协议。Agent 不需要知道 GitHub、数据库、浏览器等服务的 SDK 细节，只要能和 MCP server 通信，就可以发现工具、读取参数 schema，并在模型决定调用工具时转发请求。

当前项目里 MCP 接入分三层：

1. `src/index.ts` 启动具体 MCP server。
2. `MCPClient` 负责 stdio JSON-RPC 通信。
3. `ToolRegistry.registerMCPServer` 把 MCP 工具注册成 Agent 可调用的工具。

## 通信模型

本项目使用 MCP 的 stdio transport。Agent 通过子进程启动 MCP server：

```ts
new MCPClient(
  'bunx',
  ['-y', '@modelcontextprotocol/server-github'],
  { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
)
```

启动后有三条管道：

- `stdin`：Agent 写入 JSON-RPC 请求。
- `stdout`：MCP server 输出 JSON-RPC 响应。
- `stderr`：MCP server 输出日志或启动错误。

MCP 协议消息是一行一条 JSON-RPC：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

`MCPClient.send()` 会为每个请求分配递增的 `id`，并把 `id -> Promise` 存到 `pending`。当 stdout 返回同一个 `id` 的响应时，就 resolve 或 reject 对应的 Promise。

## 初始化流程

Agent 接入一个 MCP server 时，流程是：

1. `spawn(command, args)` 启动 MCP server 子进程。
2. 发送 `initialize`，声明协议版本和客户端信息。
3. 收到初始化响应后，发送 `notifications/initialized`。
4. 调用 `tools/list` 获取 server 暴露的工具列表。
5. 把每个 MCP tool 包装成 Agent tool。

初始化成功后，GitHub MCP server 会返回类似 `create_issue`、`list_issues`、`search_repositories` 等工具。

## 工具注册

`ToolRegistry.registerMCPServer(serverName, client)` 会读取 MCP server 的工具列表，并为每个工具生成一个带前缀的本地工具名：

```text
mcp__github__list_issues
mcp__github__search_repositories
```

前缀的作用是避免不同 MCP server 的工具重名，也让 system prompt 可以明确告诉模型：查询 GitHub 时优先使用 `mcp__github__` 工具。

每个 MCP tool 会被包装成普通 `ToolDefinition`：

- `description` 来自 MCP tool 描述。
- `parameters` 来自 MCP tool 的 `inputSchema`。
- `execute` 内部调用 `client.callTool(originalName, input)`。

这样 Agent loop 不需要区分内置工具和 MCP 工具。模型只看到统一的工具列表，执行时统一走 `ToolRegistry.toAISDKFormat()`。

## 工具调用流程

当模型选择调用 `mcp__github__list_issues` 时：

1. AI SDK 调用 ToolRegistry 包装出来的 `execute`。
2. `execute` 把前缀工具名映射回 MCP 原始工具名 `list_issues`。
3. `MCPClient.callTool()` 发送 `tools/call`：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_issues",
    "arguments": {
      "owner": "vercel",
      "repo": "ai"
    }
  }
}
```

4. MCP server 调用真实 GitHub API。
5. 返回的 `content` 文本被拼接成字符串，交还给 Agent。

## 错误和超时

MCP server 启动失败时，错误经常只写到 stderr。如果客户端忽略 stderr，用户看到的就只是 `MCP request timeout: initialize`，很难判断是 token、网络、包安装还是命令问题。

当前 `MCPClient` 会保留最近的 stderr 输出，并在这些场景里带上错误上下文：

- 子进程启动失败。
- 子进程提前退出。
- JSON-RPC 请求超时。
- stdin 写入失败。

这次 GitHub MCP 超时的直接原因就是项目使用 Bun，但原实现用 `npx` 启动 MCP server。`npx` 被 `package.json` 的 `devEngines` 拦截后退出，stderr 被吞掉，于是表现成初始化超时。改为 `bunx` 后，MCP server 可以正常启动并注册工具。

## 扩展其他 MCP server

接入新 MCP server 时通常只需要：

1. 准备启动命令、参数和环境变量。
2. 创建 `MCPClient`。
3. 调用 `toolRegistry.registerMCPServer(name, client)`。

示例：

```ts
const client = new MCPClient('bunx', ['-y', 'some-mcp-server'], {
  SOME_API_KEY: process.env.SOME_API_KEY!,
})

await toolRegistry.registerMCPServer('someService', client)
```

注册后，工具会以 `mcp__someService__toolName` 的形式暴露给 Agent。

## 生产环境 SDK 示例

[mcp-client-prod.ts](./mcp-client-prod.ts) 是一个不接入 Agent Loop 的生产环境示例。它使用官方 TypeScript SDK，而不是手写 stdio / JSON-RPC 客户端：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
```

这个示例保留了和当前 GitHub MCP 一样的运行方式：

```ts
new StdioClientTransport({
  command: 'bunx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: {
    ...getDefaultEnvironment(),
    GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
  },
  stderr: 'pipe',
})
```

运行方式：

```bash
bun src/mcp/mcp-client-prod.ts
```

它会做三件事：

1. 用 SDK `Client.connect()` 完成 MCP 初始化握手。
2. 调用 `client.listTools()` 打印 GitHub MCP 暴露的工具。
3. 调用 `client.callTool()` 演示一次 `search_repositories`。

生产环境更推荐这种写法，原因是 SDK 已经处理了这些协议细节：

- MCP 初始化握手和能力协商。
- stdio 消息分帧和 JSON-RPC request / response 匹配。
- 请求级 `timeout` 和 `AbortSignal`。
- 标准错误类型和协议兼容性。
- resources、prompts、tools 等 MCP primitives 的高层 API。

当前 [mcp-client.ts](./mcp-client.ts) 仍然适合保留为教学版实现，用来理解 MCP 的底层工作方式。如果要把生产 SDK 接入现有 Agent，只需要把 `ToolRegistry.registerMCPServer()` 依赖的 client 接口适配到 SDK 的 `listTools()` 和 `callTool()`，Agent Loop 本身不需要知道底层 transport 是手写的还是 SDK。
