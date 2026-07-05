# My Agent

一个手搓 Agent 的 TypeScript 教学项目。

这个项目不是为了封装一个通用框架，而是把 ChatBot 演进成 Agent 的关键机制拆开写清楚：

- 给模型注册工具
- 监听模型流式输出里的 `tool-call` / `tool-result`
- 把工具调用结果写回 `messages`
- 用 `while` 循环让模型继续思考和行动
- 给循环加上重试、预算和死循环防护
- 给 Agent 加上跨会话 Memory 和本地 RAG 知识库

## 教程索引

- [第一章：Agent Loop](docs/chapter-1-agent-loop.md)
- [第二章：Tool System](docs/chapter-2-tool-system.md)
- [第三章：Context Engineering](docs/chapter-3-context-engineering.md)
- [第四章：Memory 跨会话记忆](docs/chapter-4-memory.md)
- [第五章：RAG 本地知识库](docs/chapter-5-rag.md)
- [联网搜索工具说明](docs/search-tools.md)

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

联网搜索工具是可选能力。配置 `TAVILY_API_KEY` 后会优先使用 Tavily；如果没有 Tavily 但配置了 `SERPER_API_KEY`，会回退到 Serper。

RAG 也是可选能力。配置 `EMBED_API_KEY` 后，入口会注册 `rag_ingest` 和 `rag_search`，并把文档片段持久化到本地 `knowledge.db`：

```bash
EMBED_API_KEY=你的_key bun run dev
```

Memory 不需要额外配置。启动后可以让 Agent 用 `memory` 工具保存跨会话记忆，也可以在终端里输入：

```text
/memory
/memory search 偏好
/dream
```

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
    memory-tools.ts           # 跨会话记忆工具
    rag-tools.ts              # RAG 导入和搜索工具
  memory/
    store.ts                  # .memory/ 持久化、索引、搜索、lint
    validator.ts              # 记忆健康检查
  rag/
    chunker.ts                # 文档分块
    embedder.ts               # SiliconFlow embedding 包装和内存缓存
    sqlite-store.ts           # SQLite + FTS5 混合检索存储
    search.ts                 # 向量/关键词打分和 MMR
  session/
    store.ts                  # 会话持久化：把 messages 追加写入 jsonl
  context/
    prompt-builder.ts         # Prompt Pipe：按模块组装 system prompt
    prompts.ts                # coreRules / toolGuide / sessionContext 等 prompt 片段
    compressor.ts             # 上下文压缩：microCompact + LLM summarize
    defense.ts                # 三层防线：Token 估算、工具截断、TTL 修剪
    view.ts                   # /context 和 /usage 的终端视图
    compressor.test.ts        # 压缩单元测试
  usage/
    tracker.ts                # Prompt cache / token / cost 追踪
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
  dream.e2e.ts                # Memory dream 整理 E2E
  rag.e2e.ts                  # RAG 导入和搜索 E2E
```

## 当前测试覆盖

运行：

```bash
bun test
```

当前测试主要覆盖这些核心模块。

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

`memory/store.test.ts` 和 `memory-tools.test.ts`：

- 保存、列出、搜索、读取、删除记忆
- 生成 prompt-facing memory section
- 检测重复记忆
- 验证 `memory` 工具的 save/list/search/read/delete/lint 行为

专项 E2E 可以单独运行：

```bash
bun run test:e2e:compression
bun run test:e2e:defense
bun run test:e2e:agent-loop-defense
bun run test:e2e:dream
bun run test:e2e:rag
```

## 后续实验方向

当前 Agent Loop、Tool System、Context Engineering、Memory 和 RAG 的教学版都已经完成。后续如果继续写，可以作为独立实验，而不是现有章节的必做功能：

- 把循环检测结果结构化返回给上层 UI
- 用 trace id 记录每一轮 step、tool-call、tool-result 和 token usage
- 把压缩摘要持久化到 session，避免每次启动都重新摘要同一段历史
- 给 RAG 增加删除来源、重建索引和列出来源的管理工具
- 给 Memory 增加更严格的 schema 校验或自动合并策略
