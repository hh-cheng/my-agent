/**
 * Super Agent 入口（v0.2）
 *
 * 从上一篇的 ChatBot 演进为 Agent，代码层面变化不大，但行为质变——
 * AI 从"只会说"变成了"能做"：
 *
 * - 定义工具（description + inputSchema + execute）→ tools/utility-tools.ts
 * - streamText 传入 tools
 * - 用 fullStream 替代 textStream，处理工具调用事件 → agent/loop.ts
 * - while 循环支持多步执行 → agent/loop.ts
 */
import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createInterface } from 'node:readline'
import { createDeepSeek } from '@ai-sdk/deepseek'

import { MCPClient } from './mcp/mcp-client'
import { UsageTracker } from './usage/tracker'
import { SessionStore } from './session/store'
import { allTools } from './tools/utility-tools'
import { createMockModel } from './mock/mock-model'
import { ToolRegistry } from './tools/tool-registry'
import { createToolSearchTool } from './tools/tool-search'
import { agentLoop, type BudgetState } from './agent/loop'
import { pickSearchTool, webFetchTool } from './tools/search-tools'
import { applyDefense, estimateMessageTokens } from './context/defense'
import { PromptBuilder, PromptContext } from './context/prompt-builder'
import { debugLabel, logStyle, successLabel, warnLabel } from './logging'
import {
  renderUsageView,
  renderContextView,
  buildContextSnapshot,
} from './context/view.js'
import {
  toolGuide,
  coreRules,
  deferredTools,
  sessionContext,
} from './context/prompts'

const DEBUG = process.argv.includes('--debug')

function debugLog(...args: Parameters<typeof console.log>) {
  if (DEBUG) console.log(...args)
}

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

// 工具注册：streamText 通过 tools 参数暴露给模型
const toolRegistry = new ToolRegistry()
toolRegistry.register(...allTools)
toolRegistry.register(pickSearchTool(), webFetchTool)
toolRegistry.register(createToolSearchTool(toolRegistry))

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

// 预算由调用方持有，跨轮持续累积 - agentLoop 只负责消费
const budget: BudgetState = { used: 0, limit: 200_000 }

function estimateToolDescriptionChars() {
  return JSON.stringify(
    toolRegistry.getActiveTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  ).length
}

function renderStatus(
  messages: ModelMessage[],
  tracker: UsageTracker,
  system: string,
) {
  const messageTokens = estimateMessageTokens(messages)
  const tools = toolRegistry.countTokenEstimate()
  const totals = tracker.totals()
  const pct = Math.round((budget.used / budget.limit) * 100)

  return [
    '',
    logStyle.banner('Status'),
    `消息数：${messages.length}`,
    `消息 token 估算：~${messageTokens}`,
    `System prompt：${system.length} chars`,
    `工具：${toolRegistry.getActiveTools().length} active，deferred ~${tools.deferred} tokens，总计 ~${tools.total} tokens`,
    `预算：${budget.used}/${budget.limit} tokens (${pct}%)`,
    `Usage：${totals.steps} 步，$${totals.cost.toFixed(4)}，cache hit ${(totals.hitRate * 100).toFixed(1)}%`,
    '',
  ].join('\n')
}

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
    .pipe('sessionContext', sessionContext())

  const promptCtx: PromptContext = {
    sessionId,
    sessionMessageCount: messages.length,
    toolCount: toolRegistry.getActiveTools().length,
    deferredToolSummary: toolRegistry.getDeferredToolSummary(),
  }

  const SYSTEM = builder.build(promptCtx)

  if (DEBUG) builder.debug(promptCtx)

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
    await toolRegistry.closeAllMCP()
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
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        console.log('Bye!')
        await shutdown()
        return
      }

      if (trimmed === '/context') {
        const snapshot = buildContextSnapshot({
          modelName,
          modelId,
          windowTokens: budget.limit,
          systemPromptChars: SYSTEM.length,
          toolDescriptionChars: estimateToolDescriptionChars(),
          memoryChars: 0,
          skillsChars: 0,
          messages,
        })
        console.log(renderContextView(snapshot))
        ask()
        return
      }

      if (trimmed === '/usage') {
        console.log(renderUsageView(tracker))
        ask()
        return
      }

      if (trimmed === '/status') {
        console.log(renderStatus(messages, tracker, SYSTEM))
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

      await agentLoop({
        model,
        budget,
        tracker,
        modelId,
        messages,
        system: SYSTEM,
        tools: toolRegistry,
      })

      setTimestampMessages(messages, timestamps, beforeCount)
      defendMessages(messages, timestamps, 'after-loop')

      store.appendAll(messages.slice(beforeCount))

      if (!rlClosed) ask()
    })
  }

  console.log(
    logStyle.banner('Super Agent v0.10 — Cache & Cost') +
      logStyle.dim(' (type "exit" to quit)'),
  )
  console.log('/context — 终端里看 context 占用矩阵（参考 Claude Code）')
  console.log('/usage — 累计 token 用量、cache 命中率、节省金额')
  console.log('/status — 当前消息数和 token 估算')
  console.log(
    logStyle.dim(
      '对话会自动保存。用 bun run continue 恢复上次对话；加 --debug 查看辅助信息。\n',
    ),
  )
  ask()
}

main().catch(console.error)
