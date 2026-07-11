import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createInterface } from 'node:readline'
import { createDeepSeek } from '@ai-sdk/deepseek'

import { DEBUG } from './env'
import { MemoryStore } from './memory/store'
import { MCPClient } from './mcp/mcp-client'
import { SkillLoader } from './skills/loader'
import { UsageTracker } from './usage/tracker'
import { SessionStore } from './session/store'
import { HookPipeline } from './security/hooks'
import { debugCommands } from './commands/debug'
import { allTools } from './tools/utility-tools'
import { PluginManager } from './plugins/manager'
import { PluginDefinition } from './plugins/types'
import { createRagTools } from './tools/rag-tools'
import { memoryCommands } from './commands/memory'
import { ragContext } from './context/prompt-pipe'
import { createMockModel } from './mock/mock-model'
import { ChannelGateway } from './channels/gateway'
import { contextCommands } from './commands/context'
import { ToolRegistry } from './tools/tool-registry'
import { SqliteVectorStore } from './rag/sqlite-store'
import { createSkillCommands } from './commands/skills'
import { createMemoryTool } from './tools/memory-tools'
import { createDashScopeEmbedder } from './rag/embedder'
import { createPluginCommands } from './commands/plugin'
import { createToolSearchTool } from './tools/tool-search'
import { agentLoop, type BudgetState } from './agent/loop'
import { createChannelCommands } from './commands/channel'
import { createFeishuPlugin } from './channels/adapters/feishu'
import { createSecurityCommands } from './commands/security'
import { registeredPipelines } from './security/hook-instances'
import { createDispatcher, type CommandContext } from './commands'
import { pickSearchTool, webFetchTool } from './tools/search-tools'
import { applyDefense, estimateMessageTokens } from './context/defense'
import { PromptBuilder, type PromptContext } from './context/prompt-builder'
import {
  debugLabel,
  debugLog,
  logStyle,
  successLabel,
  warnLabel,
} from './logging'
import {
  toolGuide,
  coreRules,
  deferredTools,
  sessionContext,
} from './context/prompts'

const deepSeek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const model = process.env.DEEPSEEK_API_KEY
  ? deepSeek.chat('deepseek-v4-flash')
  : createMockModel()

const modelId = String((model as any).modelId ?? 'mock-model')
const modelName = process.env.DEEPSEEK_API_KEY
  ? 'DeepSeek V4 Flash'
  : 'Mock Model'

//* === 工具注册：streamText 通过 tools 参数暴露给模型 ===
const toolRegistry = new ToolRegistry()
toolRegistry.register(...allTools)
toolRegistry.register(pickSearchTool(), webFetchTool)
toolRegistry.register(createToolSearchTool(toolRegistry))

//* === Memory ===
const memoryStore = new MemoryStore('.')
toolRegistry.register(createMemoryTool(memoryStore))

//* === RAG ===
const ragEnabled = Boolean(process.env.EMBED_API_KEY)
const vectorStore = ragEnabled ? new SqliteVectorStore() : null
if (ragEnabled && vectorStore) {
  const embedFn = createDashScopeEmbedder()
  toolRegistry.register(...createRagTools(vectorStore, embedFn))
}

//* === skills ===
const skillLoader = new SkillLoader('.')
skillLoader.load()
const activeSkills = new Set<string>()

debugLog(
  `${successLabel('工具')} 已注册 ${toolRegistry.getAll().length} 个工具`,
)
for (const tool of toolRegistry.getAll()) {
  const flags = [
    tool.isReadOnly ? '只读' : '可写',
    tool.isConcurrencySafe ? '可并发' : '串行',
  ].join(', ')

  debugLog(`  - ${tool.name} (${flags})`)
}

//* 预算由调用方持有，跨轮持续累积 - agentLoop 只负责消费
const budget: BudgetState = { used: 0, limit: 200_000 }

//* === plugins ===
const pluginManager = new PluginManager(toolRegistry)
const feishuPlugin = createFeishuPlugin()
const availablePlugins = new Map<string, PluginDefinition>([
  [feishuPlugin.name, feishuPlugin],
])

//* === pipelines ===
const hookPipelines = new HookPipeline()
registeredPipelines.pre.forEach(({ name, pipeline }) =>
  hookPipelines.registerPre(name, pipeline),
)
registeredPipelines.post.forEach(({ name, pipeline }) =>
  hookPipelines.registerPost(name, pipeline),
)
toolRegistry.setHookPipeline(hookPipelines)

//* === timestamps 记录每条消息进入上下文的时间，用于 context defense 的 TTL 修剪 ===
function setTimestampMessages(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  startIndex = 0,
  timestamp = Date.now(),
) {
  for (let i = startIndex; i < messages.length; i++) {
    if (!timestamps.has(i)) timestamps.set(i, timestamp)
  }
}

function syncTimestamps(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
) {
  for (const idx of timestamps.keys()) {
    if (!messages[idx]) timestamps.delete(idx)
  }
}

//* === 统一执行上下文防线：同步 timestamps、应用裁剪/压缩策略，并回写 messages ===
function defendMessages(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  label: string,
) {
  syncTimestamps(messages, timestamps)

  const before = estimateMessageTokens(messages)
  const defense = applyDefense(messages, timestamps)
  messages.splice(0, messages.length, ...defense.messages)
  syncTimestamps(messages, timestamps)

  const changed =
    defense.truncated +
    defense.compacted +
    defense.softPruned +
    defense.hardPruned

  if (changed > 0) {
    debugLog(
      `\n${warnLabel(`防线:${label}`)} ~${before} → ~${defense.estimatedTokens} tokens`,
    )
    debugLog(
      `  ${debugLabel('Layer 2')} 截断: ${defense.truncated}，预算清理: ${defense.compacted}`,
    )
    debugLog(
      `  ${debugLabel('Layer 3')} 软修剪: ${defense.softPruned}，硬清除: ${defense.hardPruned}`,
    )
  }

  return defense
}

//* === MCP ===
async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN

  let canSpawn = true
  try {
    const { execSync } = await import('node:child_process')
    execSync('echo test', { stdio: 'ignore' })
  } catch {
    canSpawn = false
  }

  if (githubToken && canSpawn) {
    debugLog(`\n${debugLabel('MCP')} 连接 GitHub MCP Server...`)
    try {
      const client = new MCPClient(
        'bunx',
        ['-y', '@modelcontextprotocol/server-github'],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      )
      const tools = await toolRegistry.registerMCPServer('github', client)
      debugLog(
        `${successLabel('MCP')} 已注册 ${tools.length} 个 GitHub MCP 工具`,
      )
      return
    } catch (err) {
      debugLog(
        `${warnLabel('MCP')} 连接失败: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  if (!githubToken) {
    debugLog(
      `\n${warnLabel('MCP')} 未配置 GITHUB_PERSONAL_ACCESS_TOKEN，跳过 GitHub MCP Server`,
    )
  }
}

async function main() {
  await memoryStore.init()
  await connectMCP()

  //* === 用量追踪 ===
  const tracker = new UsageTracker()

  //* === 工具统计 ===
  debugLog(
    `\n${successLabel('工具')} 已注册 ${toolRegistry.getAll().length} 个工具: `,
  )
  for (const tool of toolRegistry.getAll()) {
    const isMCP = tool.name.startsWith('mcp__')
    const flags = [
      isMCP ? 'MCP' : '内置',
      tool.isConcurrencySafe ? '可并发' : '串行',
    ].join(', ')

    debugLog(`  - ${tool.name} (${flags})`)
  }

  const allCount = toolRegistry.getAll().length
  const activeTools = toolRegistry.getActiveTools()
  const estimate = toolRegistry.countTokenEstimate()

  debugLog(`\n${logStyle.banner('=== 工具统计 ===')}`)
  debugLog(`全部工具：${allCount}个`)
  debugLog(`活跃工具：${activeTools.length}个`)
  debugLog(`延迟工具：${estimate.deferred}个`)
  debugLog(
    `Token 估算：~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`,
  )

  //* === 消息历史 ===
  let messages: ModelMessage[] = []
  const timestamps = new Map<number, number>()
  const sessionId = 'default'
  const store = new SessionStore(sessionId)
  const isContinue = process.argv.includes('--continue')

  if (isContinue && store.exists()) {
    messages = store.load()
    setTimestampMessages(messages, timestamps)
    debugLog(
      `\n${debugLabel('Session')} 恢复会话 "${sessionId}"，${messages.length} 条历史消息`,
    )
  } else {
    debugLog(`\n${debugLabel('Session')} 新会话 "${sessionId}"`)
  }

  defendMessages(messages, timestamps, 'session-start')

  //* === 组装 system prompt ===
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', () => memoryStore.buildPromptSection())
    .pipe('ragContext', vectorStore ? ragContext(vectorStore) : () => null)
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext())

  const makePromptCtx = (): PromptContext => {
    return {
      sessionId,
      sessionMessageCount: messages.length,
      toolCount: toolRegistry.getActiveTools().length,
      deferredToolSummary: toolRegistry.getDeferredToolSummary(),
    }
  }

  if (DEBUG) await builder.debug(makePromptCtx())

  //* === Channel Gateway ===
  const gateway = new ChannelGateway({
    model,
    registry: toolRegistry,
    buildSystem: () => builder.build(makePromptCtx()),
  })
  pluginManager.setChannelGateway(gateway)
  await pluginManager.load(feishuPlugin)
  await gateway.startAll()

  //* === 命令 ===
  const dispatch = createDispatcher([
    ...debugCommands,
    ...memoryCommands,
    ...contextCommands,
    ...createChannelCommands(gateway),
    ...createSkillCommands(skillLoader, activeSkills),
    ...createPluginCommands(pluginManager, availablePlugins),
    ...createSecurityCommands(toolRegistry, hookPipelines),
  ])

  //* === 交互循环 ===
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let rlClosed = false
  let shuttingDown = false
  rl.on('close', () => {
    rlClosed = true
  })

  //* === 退出处理 ===
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true

    if (!rlClosed) rl.close()
    await gateway.stopAll()
    await toolRegistry.closeAllMCP()
    vectorStore?.close()
  }

  process.once('SIGINT', async () => {
    console.log()
    await shutdown()
    process.exit(130)
  })

  //* === 问答循环 ===
  const ask = () => {
    if (rlClosed) return

    rl.question('\nYou: ', async (ipt) => {
      const trimmed = ipt.trim()
      if (!trimmed || /\/?exit/.test(trimmed.toLocaleLowerCase())) {
        console.log('Bye!')
        await shutdown()
        return
      }

      const commandCtx: CommandContext = {
        model,
        modelName,
        modelId,
        budget,
        tracker,
        registry: toolRegistry,
        builder,
        messages,
        memoryStore,
        sessionStore: store,
        timestamps,
        ask,
        makePromptCtx,
      }
      const handled = await dispatch(trimmed, commandCtx)
      if (handled === 'async') return
      if (handled) {
        ask()
        return
      }

      const beforeCount = messages.length
      const userMessage = {
        role: 'user',
        content: trimmed,
      } satisfies ModelMessage
      messages.push(userMessage)
      timestamps.set(messages.length - 1, Date.now())

      defendMessages(messages, timestamps, 'before-loop')

      // 记忆变化时，下一轮对话的 system prompt 就包含最新的记忆内容
      const currentSystem = await builder.build(makePromptCtx())
      await agentLoop({
        model,
        budget,
        tracker,
        modelId,
        messages,
        system: currentSystem,
        tools: toolRegistry,
      })

      setTimestampMessages(messages, timestamps, beforeCount)
      defendMessages(messages, timestamps, 'after-loop')

      store.appendAll(messages.slice(beforeCount))

      if (!rlClosed) ask()
    })
  }

  console.log(
    logStyle.banner('Super Agent') +
      logStyle.dim(' (type "/exit" or "exit" to quit)'),
  )
  console.log(
    logStyle.dim(
      '对话会自动保存。用 bun run continue 恢复上次对话；加 --debug 查看辅助信息。\n',
    ),
  )
  ask()
}

main().catch(console.error)
