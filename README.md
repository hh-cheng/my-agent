# My Agent

一个手搓 Agent 的 TypeScript 教学项目。

这个项目不是为了封装一个通用框架，而是把 ChatBot 演进成 Agent 的关键机制拆开写清楚：

- 给模型注册工具
- 监听模型流式输出里的 `tool-call` / `tool-result`
- 把工具调用结果写回 `messages`
- 用 `while` 循环让模型继续思考和行动
- 给循环加上重试、预算和死循环防护
- 给 Agent 加上跨会话 Memory 和本地 RAG 知识库
- 通过 Skills、Plugins 和 Channels 扩展 Agent 的工作方式、能力和入口
- 用权限、Cron 和 Multi-Agent 约束、调度并拆分复杂任务

## 教程索引

- [第一章：Agent Loop](docs/chapter-1-agent-loop.md)
- [第二章：Tool System](docs/chapter-2-tool-system.md)
- [第三章：Context Engineering](docs/chapter-3-context-engineering.md)
- [第四章：Memory 跨会话记忆](docs/chapter-4-memory.md)
- [第五章：RAG 本地知识库](docs/chapter-5-rag.md)
- [第六章：Skills、Plugins 和 Channels](docs/chapter-6-skills-plugins-channels.md)
- [第七章：权限、Cron 和 Multi-Agent](docs/chapter-7-security-cron-multi-agent.md)
- [联网搜索工具说明](docs/search-tools.md)

## 快速开始

项目固定使用 Bun `1.3.11`，建议先确认本地版本：

```bash
bun --version
```

安装依赖：

```bash
bun install
```

复制环境变量模板：

```bash
cp .env.example .env
```

启动交互式 Demo：

```bash
bun run dev
```

没有配置 `DEEPSEEK_API_KEY` 时，项目会自动使用本地 mock model。配置后会切换到 `deepseek-v4-flash`：

```bash
DEEPSEEK_API_KEY=你的_key bun run dev
```

恢复默认持久化会话或以 watch 模式开发：

```bash
bun run continue
bun run watch
bun run dev --debug
```

### 可选能力

- 联网搜索：配置 `TAVILY_API_KEY` 后优先使用 Tavily；只配置 `SERPER_API_KEY` 时回退到 Serper。
- RAG：配置 `EMBED_API_KEY` 后注册 `rag_ingest` 和 `rag_search`，数据持久化到 `knowledge.db`。
- GitHub MCP：配置 `GITHUB_PERSONAL_ACCESS_TOKEN` 后尝试启动 GitHub MCP Server，并把远端工具注册为 `mcp__github__*`。
- 飞书 Channel：总是启动本地 Dashboard；配置 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 后额外连接飞书长连接，端口由 `FEISHU_PORT` 控制。

例如启用 RAG：

```bash
EMBED_API_KEY=你的_key bun run dev
```

### 常用终端命令

Memory 不需要额外配置：

```text
/memory
/memory search 偏好
/lint
/dream
```

查看上下文和用量：

```text
/context
/usage
/status
```

管理 Skills、Plugins 和 Channels：

```text
/skill
/skill load code-review
/skill unload code-review
/code-review src/tools
/plugin
/channel
```

查看权限、Hook、Cron 和子 Agent：

```text
/role
/role guest
/hooks
/cron
/cron logs
/agents
```

未配置飞书凭证时，可以打开 `http://localhost:3000`，通过 Dashboard 发送测试消息。

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
.
├── src/
│   ├── index.ts                    # Runtime 入口与各模块装配
│   ├── env.ts                      # DEBUG 等运行环境开关
│   ├── logging.ts                  # 终端日志样式和输出
│   ├── agent/
│   │   ├── loop.ts                 # Agent Loop、step 消费和预算控制
│   │   ├── retry.ts                # 模型调用重试策略
│   │   └── loop-detection.ts       # 重复调用、ping-pong 和无进展检测
│   ├── agents/
│   │   ├── types.ts                # 子 Agent 配置、请求与运行状态
│   │   ├── registry.ts             # 深度、并发限制和运行记录
│   │   └── spawn.ts                # 独立上下文执行与并行派发
│   ├── tools/
│   │   ├── tool-registry.ts        # 注册、权限过滤、Hook、锁和结果截断
│   │   ├── utility-tools.ts        # 文件、搜索、计算、天气和 Bash 工具
│   │   ├── search-tools.ts         # Tavily / Serper 搜索和网页抓取
│   │   ├── tool-search.ts          # 延迟工具发现
│   │   ├── memory-tools.ts         # Memory 管理工具
│   │   ├── rag-tools.ts            # RAG 导入和搜索工具
│   │   ├── cron-tools.ts           # 定时任务管理工具
│   │   └── spawn-tools.ts          # 子 Agent 派发工具
│   ├── commands/
│   │   ├── index.ts                # Slash command dispatcher
│   │   ├── memory.ts               # /memory、/lint、/dream
│   │   ├── context.ts              # /context、/usage
│   │   ├── debug.ts                # /status 和防线调试命令
│   │   ├── skills.ts               # /skill 和 /<skill-name>
│   │   ├── plugin.ts               # /plugin
│   │   ├── channel.ts              # /channel
│   │   ├── security.ts             # /role、/hooks
│   │   ├── cron.ts                 # /cron
│   │   └── agents.ts               # /agents
│   ├── context/
│   │   ├── prompt-builder.ts       # Prompt Pipe 组装器
│   │   ├── prompt-pipe.ts          # Memory / RAG prompt pipe
│   │   ├── prompts.ts              # Core、工具和 Session prompt 片段
│   │   ├── compressor.ts           # microCompact 与 LLM summarize
│   │   ├── defense.ts              # 截断、预算清理和 TTL 修剪
│   │   └── view.ts                 # Context / Usage 终端视图
│   ├── security/
│   │   ├── roles.ts                # owner / collaborator / guest 权限
│   │   ├── bash-classifier.ts      # Bash 命令风险分类
│   │   ├── hooks.ts                # Pre/Post Tool Hook Pipeline
│   │   └── hook-instances/         # 内置审计与输出处理 Hook
│   ├── cron/
│   │   ├── types.ts                # 任务配置、payload 和运行状态
│   │   ├── parser.ts               # interval / cron / once 解析
│   │   ├── service.ts              # 调度、执行、失败熔断和通知
│   │   └── store.ts                # .cron/ 配置与日志持久化
│   ├── memory/
│   │   ├── store.ts                # .memory/ 持久化、索引和搜索
│   │   └── validator.ts            # 重复、失效记忆检查
│   ├── rag/
│   │   ├── store.ts                # VectorStore 接口与公共类型
│   │   ├── chunker.ts              # 文档分块
│   │   ├── embedder.ts             # Embedding API 包装和内存缓存
│   │   ├── sqlite-store.ts         # SQLite + FTS5 混合检索存储
│   │   └── search.ts               # 相似度、混合打分和 MMR
│   ├── skills/
│   │   └── loader.ts               # 加载 .skills/*/SKILL.md
│   ├── plugins/
│   │   ├── types.ts                # PluginDefinition / PluginApi
│   │   └── manager.ts              # 插件生命周期与能力回收
│   ├── channels/
│   │   ├── types.ts                # Channel 输入输出协议
│   │   ├── gateway.ts              # 外部消息到 Agent Loop 的桥接
│   │   └── adapters/feishu.ts      # 飞书与本地 Dashboard 示例
│   ├── session/
│   │   └── store.ts                # JSONL 会话持久化
│   ├── usage/
│   │   └── tracker.ts              # Token、prompt cache 和成本追踪
│   ├── mcp/
│   │   ├── mcp-client.ts           # Runtime 使用的 stdio MCP Client
│   │   └── mcp-client-prod.ts      # 官方 SDK GitHub MCP 演示
│   └── mock/
│       ├── mock-model.ts           # 无模型凭证时的本地模拟模型
│       ├── mock-pages.ts           # 搜索工具的本地模拟页面
│       └── mock-index.ts           # v0.1 ChatBot 阶段示例
├── .skills/
│   └── code-review/SKILL.md        # 示例 Skill
├── app/
│   └── index.html                  # Channel 本地测试 Dashboard
├── docs/                           # 七章教程与搜索工具说明
├── e2e/                            # Compression、Defense、RAG 等 E2E
└── package.json                    # Bun scripts 和依赖
```

运行时数据保存在项目根目录：

- `.sessions/`：默认会话 JSONL。
- `.memory/`：跨会话 Memory 文件和索引。
- `.cron/`：定时任务配置与执行日志。
- `knowledge.db*`：启用 RAG 后生成的 SQLite 数据库及 WAL 文件。

这些内容都属于本地状态，不应提交到 Git。

## 当前测试覆盖

运行：

```bash
bun test
```

`bun test` 默认运行源码旁的单元测试，当前主要覆盖这些核心模块。

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

专项 E2E 不属于默认 `bun test`，按需单独运行。其中 `plugins.e2e.ts` 覆盖：

- 插件注册工具、执行工具、卸载后移除工具
- 插件注册 Channel、卸载后移除 Channel

全部专项命令：

```bash
bun run test:e2e:compression
bun run test:e2e:defense
bun run test:e2e:agent-loop-defense
bun run test:e2e:dream
bun run test:e2e:rag
bun run test:e2e:plugins
```

## 后续实验方向

当前 Agent Loop、Tool System、Context Engineering、Memory、RAG、Skills、Plugins、Channels、权限、Cron 和 Multi-Agent 的教学版都已经完成。后续如果继续写，可以作为独立实验，而不是现有章节的必做功能：

- 把循环检测结果结构化返回给上层 UI
- 用 trace id 记录每一轮 step、tool-call、tool-result 和 token usage
- 把压缩摘要持久化到 session，避免每次启动都重新摘要同一段历史
- 给 RAG 增加删除来源、重建索引和列出来源的管理工具
- 给 Memory 增加更严格的 schema 校验或自动合并策略
- 给 Plugin 增加 manifest 文件扫描和按目录自动发现
- 给 Channel 增加持久化会话，避免外部通道重启后丢上下文
- 给 Cron 执行器接入 AbortSignal，实现真正的任务超时
- 让子 Agent 的 unlocked 工具路径继续执行安全 Hook，并落实工具白名单
