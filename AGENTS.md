# AGENTS.md

Guidance for coding agents working in this repository.

## Project Overview

This is a Bun + TypeScript teaching project that builds a small agent runtime from first principles. It is not a general framework. Keep changes focused on the mechanisms already present:

- Agent loop orchestration in `src/agent/loop.ts`
- Tool registration and execution in `src/tools/`
- Context, prompt, compression, and terminal views in `src/context/`
- Session persistence in `src/session/`
- Usage/cost tracking in `src/usage/`
- Cross-session memory in `src/memory/`, `src/tools/memory-tools.ts`, and
  `src/commands/memory.ts`
- RAG document ingestion/search in `src/rag/` and `src/tools/rag-tools.ts`
- Optional MCP integration in `src/mcp/`
- Local mock model support in `src/mock/`

The CLI entry point is `src/index.ts`. It registers tools, initializes memory
and optional RAG, builds the system prompt, loads optional session history,
applies context defense, and starts the readline loop.

## Common Commands

Use Bun. The repo declares `bun@1.3.11`.

```bash
bun install
bun run dev
bun run continue
bun test
bun run test:e2e:compression
bun run test:e2e:defense
bun run test:e2e:agent-loop-defense
bun run test:e2e:dream
bun run test:e2e:rag
bunx biome check src/index.ts src/agent/loop.ts
bunx tsc --noEmit
```

Notes:

- `bun run dev` uses a local mock model when `DEEPSEEK_API_KEY` is not set.
- `bun run continue` restores the default persisted session.
- E2E tests may require real model credentials or external services.
- At the time this file was created, full `bunx tsc --noEmit` fails on `src/mock/mock-index.ts` because the old v0.1 demo passes internal `ToolDefinition` objects directly to AI SDK `tools`. Do not assume a new change caused that failure unless the error changes.

## Environment Variables

Copy `.env.example` to `.env` for local runs:

```bash
cp .env.example .env
```

Supported variables:

- `DEEPSEEK_API_KEY`: switches from mock model to `deepseek-v4-flash`.
- `TAVILY_API_KEY`: preferred provider for `web_search`.
- `SERPER_API_KEY`: fallback provider for `web_search`.
- `EMBED_API_KEY`: enables RAG tools and calls the SiliconFlow embeddings API.
- `GITHUB_PERSONAL_ACCESS_TOKEN`: enables the optional GitHub MCP server.

Never commit real secrets.

## Code Style

- TypeScript ESM, strict mode.
- Prefer existing `@/*` imports for cross-directory source imports; relative imports are common for nearby files.
- Biome formatting: 2 spaces, single quotes, no semicolons, 80-column line width.
- Keep comments useful and short. This repo uses Chinese comments heavily; matching that style is fine.
- Avoid broad refactors. This is a teaching codebase, so clarity beats clever abstraction.
- Use `rg` for searching and `bun test` for the default verification pass.

## Architecture Notes

### Agent Loop

`agentLoop` consumes `result.fullStream` from AI SDK so it can see:

- `text-delta`
- `tool-call`
- `tool-result`

After each step it appends `stepResponse.messages` back into the shared `messages` array. This is required so later model calls can see prior tool calls and results.

The loop also owns:

- Retry policy via `src/agent/retry.ts`
- Budget accounting through a caller-owned `BudgetState`
- Loop detection through `src/agent/loop-detection.ts`
- Optional usage tracking through `UsageTracker`

Keep `messages` mutation behavior explicit. Callers rely on it.

### Tool System

Tools use the local `ToolDefinition` shape in `src/tools/tool-registry.ts`. The registry converts them to AI SDK format with `inputSchema: jsonSchema(tool.parameters)`.

Tool metadata matters:

- `description`: model-facing usage guidance.
- `parameters`: JSON Schema for model input.
- `isReadOnly`: semantic hint.
- `isConcurrencySafe`: controls read/write lock behavior.
- `maxResultChars`: limits model-visible tool result size.
- `shouldDefer` and `searchHint`: support deferred tools surfaced through `tool_search`.

Do not bypass `ToolRegistry.toAISDKFormat()` in current agent paths.

### Context Management

`src/context/defense.ts` applies local context defenses before and after loop execution:

- token estimation
- large tool result truncation
- budget compaction
- TTL pruning

`src/context/compressor.ts` contains a separate compression path with unit and E2E tests.

`src/context/view.ts` renders the `/context` and `/usage` terminal views. Slash commands are handled in `src/index.ts` and should not be written into conversation history.

Memory and RAG are added to the system prompt through `PromptBuilder` pipes in
`src/index.ts`:

- `memoryContext` reads the memory index from `MemoryStore`.
- `ragContext` summarizes the current vector store and tells the model to use
  `rag_search`.

When changing prompt behavior, prefer editing or adding pipes in
`src/context/prompt-pipe.ts` or `src/context/prompts.ts` instead of embedding
more text directly in `src/index.ts`.

### Sessions

`SessionStore` persists messages as JSONL. `src/index.ts` uses `beforeCount` and saves only `messages.slice(beforeCount)` after each user turn. Preserve that pattern to avoid duplicating prior history.

### Memory

`MemoryStore` persists cross-session memory under `.memory/`:

- `.memory/MEMORY.md` is the compact prompt-facing index.
- Individual memory files use frontmatter with `name`, `description`, and
  `type`.
- Supported types are `user`, `feedback`, `project`, and `reference`.

The `memory` tool supports `save`, `list`, `search`, `read`, `delete`, and
`lint`. Terminal commands live in `src/commands/memory.ts`:

- `/memory` lists stored memories.
- `/memory search <query>` searches memory.
- `/dream` runs the agent loop to lint and clean stale or duplicate memory.

Memory is a hinting layer, not a source of truth. Preserve the existing rule in
`MemoryStore.buildPromptSection()`: verify remembered claims against files or
other tools before relying on them.

### RAG

RAG is optional and only enabled when `EMBED_API_KEY` exists. `src/index.ts`
creates `SqliteVectorStore`, registers `rag_ingest` and `rag_search`, and closes
the store during shutdown.

Current implementation details:

- `src/rag/chunker.ts` chunks documents.
- `src/rag/embedder.ts` wraps the SiliconFlow embeddings API and caches
  embeddings in memory.
- `src/rag/sqlite-store.ts` stores chunks in `knowledge.db`, keeps FTS5 rows in
  sync, and performs hybrid vector + keyword search.
- `src/rag/search.ts` contains shared search scoring/MMR helpers.

Keep RAG changes small and educational. Do not introduce a hosted vector
database or background ingestion pipeline unless the task explicitly calls for
it.

### MCP

MCP support is optional. `src/index.ts` attempts to connect to GitHub MCP only when `GITHUB_PERSONAL_ACCESS_TOKEN` exists and subprocess spawning works. Always close MCP clients through `toolRegistry.closeAllMCP()` during shutdown.

## Testing Guidance

For most changes run:

```bash
bun test
```

For formatter/lint checks on edited TS files:

```bash
bunx biome check <files>
```

Run targeted E2E tests only when touching the matching subsystem:

- compression changes: `bun run test:e2e:compression`
- context defense changes: `bun run test:e2e:defense`
- agent loop defense changes: `bun run test:e2e:agent-loop-defense`
- memory cleanup or `/dream` changes: `bun run test:e2e:dream`
- RAG ingestion/search changes: `bun run test:e2e:rag`

If you run `bunx tsc --noEmit`, mention the known `src/mock/mock-index.ts` failure unless you fix it.

## Git And Generated Files

- Do not commit `.env`, session data, logs, `.memory/`, `knowledge.db`,
  `knowledge.db-*`, or generated build output.
- `node_modules/`, `dist/`, `build/`, `out/`, and `bun.lock` are not useful to inspect for normal changes.
- Pre-commit runs `biome check --write --no-errors-on-unmatched` on staged JS/TS/JSON files.

## Practical Rules For Future Agents

- Read the relevant module before editing; many files are intentionally educational and include rationale.
- Keep slash commands local to `src/index.ts` unless they need shared rendering helpers.
- Keep provider-specific usage normalization in `src/usage/tracker.ts`.
- When adding tools, update `allTools` in `src/tools/utility-tools.ts` or the relevant registry path, and set concurrency metadata deliberately.
- When changing memory behavior, update `src/memory/*`, `src/tools/memory-tools.ts`, and `src/commands/memory.ts` together when the behavior crosses those boundaries.
- When changing RAG behavior, keep `src/rag/*` storage/search logic separate from tool presentation in `src/tools/rag-tools.ts`.
- When changing prompt behavior, prefer a new or edited pipe in `src/context/prompt-pipe.ts` or `src/context/prompts.ts` over embedding more text directly in `src/index.ts`.
- Keep all E2E tests under `e2e/`; unit tests can stay next to source files.
- When changing context pruning, add or update tests in `src/context/*test.ts` or `e2e/`.
