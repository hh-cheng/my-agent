# 搜索工具配置

项目里有两类联网工具：

- `web_search`：搜索互联网，返回标题、链接和摘要
- `web_fetch`：抓取指定网页内容，并转换为 Markdown

## 环境变量

先复制示例文件：

```bash
cp .env.example .env
```

然后按需要填写搜索服务 API key：

```bash
TAVILY_API_KEY=
SERPER_API_KEY=
```

两个 key 都是可选的，但至少配置一个，`web_search` 才能正常联网搜索。

## 搜索服务选择顺序

[src/tools/search-tools.ts](../src/tools/search-tools.ts) 里的 `pickSearchTool()` 会按下面的顺序选择搜索实现：

1. 如果配置了 `TAVILY_API_KEY`，使用 Tavily。
2. 如果没有 Tavily，但配置了 `SERPER_API_KEY`，使用 Serper。
3. 如果两个都没有，仍注册 Tavily 版 `web_search`，调用时返回缺少 `TAVILY_API_KEY` 的提示。

也就是说，Tavily 是默认首选，Serper 是 fallback。

## 工具行为

### `web_search`

参数：

```ts
{
  query: string
  max_results?: number
}
```

默认返回 5 条结果，最多返回给模型的字符数由 `maxResultChars: 3000` 控制。搜索结果会进入 Agent Loop 的 `messages`，模型随后基于结果继续回答。

### `web_fetch`

参数：

```ts
{
  url: string
}
```

`web_fetch` 不需要 API key。它会：

- 使用 `fetch` 请求页面
- 设置 15 秒超时
- 移除 `script`、`style`、`nav`、`footer`、`header`、`iframe`
- 用 Turndown 把 HTML 转成 Markdown
- 最多返回 3000 字符给模型

## 使用示例

启动项目：

```bash
bun run dev
```

可以尝试：

```text
今天 OpenAI API 有什么最新变化？
```

或者：

```text
抓取 https://example.com 并总结页面内容
```

## 注意事项

- `web_search` 和 `web_fetch` 都是只读、可并发工具。
- 搜索摘要不等于完整网页内容；如果需要核对原文，应继续调用 `web_fetch` 抓取具体 URL。
- `web_fetch` 不能绕过网站登录、反爬或付费墙限制。
- 工具结果会被 `ToolRegistry` 截断，长页面不会完整进入模型上下文。
