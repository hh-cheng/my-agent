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
