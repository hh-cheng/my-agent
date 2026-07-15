# 第五章：RAG 本地知识库

RAG 解决的是另一类问题：有些信息不适合存成 Memory。

Memory 适合短小、长期、有主观选择的信息；RAG 适合较长的文档、制度、说明书、资料库。当前项目实现的是一个本地教学版 RAG：

- 文档从本地路径导入
- 按段落和句子分块
- 调用 embedding API 生成向量
- 写入本地 SQLite
- 搜索时同时做向量检索和关键词检索

### 1. 启用 RAG

RAG 需要同时在配置中启用并提供 embedding API key。Runtime 装配层
[src/main.ts](../src/main.ts) 里是这样接线的：

```ts
const ragEnabled = config.rag.enabled && Boolean(process.env.EMBED_API_KEY)
const vectorStore = ragEnabled
  ? new SqliteVectorStore(config.rag.databasePath)
  : null

if (ragEnabled && vectorStore) {
  const embedFn = createDashScopeEmbedder()
  toolRegistry.register(
    ...createRagTools(vectorStore, embedFn, config.rag.docsDir),
  )
}
```

配置方式：

```bash
EMBED_API_KEY=你的_key bun run dev
```

启用后会多出两个工具：

- `rag_ingest`：导入本地文档
- `rag_search`：搜索已导入的知识库

默认数据库文件是项目根目录的 `knowledge.db`，可以通过 `rag.databasePath` 修改。SQLite 开启 WAL 后，还可能生成 `knowledge.db-wal` 和 `knowledge.db-shm`。

### 2. rag_ingest：文档分块、向量化、入库

RAG 工具定义在 [src/tools/rag-tools.ts](../src/tools/rag-tools.ts)。导入流程很短：

```ts
const text = await Bun.file(path).text()
const chunks = chunkDocument(path, text)
const embeddings = await embed(
  embedFn,
  chunks.map((c) => c.text),
)
vectorStore.addBatch(
  chunks.map((c, i) => ({ chunk: c, embedding: embeddings[i] })),
)
```

分块逻辑在 [src/rag/chunker.ts](../src/rag/chunker.ts)。当前目标大小是约 256 tokens，也就是大约 1024 字符：

```ts
const TARGET_TOKENS = 256
const CHARS_PER_TOKEN = 4
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN
```

它先按空行拆段落；如果单个段落过长，再按句号、问号、感叹号等句子边界切开。

每个 chunk 的 id 是：

```ts
id: `${source}#${index}`
```

所以重复导入同一个文件时，同一位置的 chunk 会覆盖旧记录，而不是无限追加。

### 3. embedder：把供应商细节包起来

Embedding 包装在 [src/rag/embedder.ts](../src/rag/embedder.ts)：

```ts
export type EmbeddingFn = (texts: string[]) => Promise<number[][]>
```

项目里所有 RAG 代码都依赖这个通用函数类型，而不是直接依赖某个供应商 SDK。当前真实实现调用 SiliconFlow embeddings API：

```ts
model: 'Qwen/Qwen3-VL-Embedding-8B'
dimensions: 128
```

外面还有一层 `embed()` 缓存：

```ts
const embedCache = new Map<string, number[]>()
```

它只缓存当前进程内已经算过的文本向量。这个缓存不会落盘；真正持久化的是 SQLite 里的 chunk 和 embedding。

### 4. SqliteVectorStore：SQLite + FTS5 混合检索

存储实现在 [src/rag/sqlite-store.ts](../src/rag/sqlite-store.ts)。它维护两张表：

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  embedding TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  id UNINDEXED,
  source UNINDEXED
);
```

`chunks` 保存原文和 JSON 序列化后的 embedding；`chunks_fts` 给关键词检索用。每次 add 时，代码会先 upsert `chunks`，再同步更新 FTS：

```ts
this.db.query('DELETE FROM chunks_fts WHERE id = ?').run(chunk.id)
this.db
  .query('INSERT INTO chunks_fts (id, text, source) VALUES (?, ?, ?)')
  .run(chunk.id, chunk.text, chunk.source)
```

搜索时不是只看向量相似度，而是混合两路结果：

- 向量分数权重：`0.7`
- 关键词分数权重：`0.3`

```ts
const vectorResults = this.vectorSearch(queryVec, candidateCount)
const keywordResults = this.keywordSearch(query, candidateCount)
```

最后用 MMR 做一次多样性选择，避免 topK 全部来自同一段高度相似文本。

### 5. ragContext：告诉模型知识库当前有什么

RAG 不会把知识库全文塞进 system prompt。Prompt 里只放一个摘要：

```ts
export function ragContext(vectorStore: SqliteVectorStore): PipeFn {
  return () => {
    const size = vectorStore.size()
    if (size === 0) return null
    const sources = vectorStore.sources()
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`
  }
}
```

这跟 Memory 的思路一致：prompt 里放“索引和提示”，细节通过工具按需检索。

### 6. 交互示例

启动：

```bash
EMBED_API_KEY=你的_key bun run dev
```

然后可以直接让 Agent 导入并查询：

```text
You: 把 README.md 导入知识库
You: 从知识库里搜一下 Tool System 的并发控制是怎么做的
```

模型会先调用 `rag_ingest`，再在后续问题里调用 `rag_search`。工具返回的结果形状类似：

```text
[1] 来源: README.md | 分数: 0.842
...相关片段...
```

如果知识库为空，`rag_search` 会返回：

```text
知识库为空，请先导入文档。
```

### 7. RAG 的测试

RAG E2E 有两种路径：

```bash
bun run test:e2e:rag
```

没有 `EMBED_API_KEY` 时，测试会使用假的 embedding 函数，验证导入、SQLite 存储和搜索排序。配置了 `EMBED_API_KEY` 时，会额外跑真实 embedding 模型测试。
