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
import { SessionStore } from './session/store'
import { allTools } from './tools/utility-tools'
import { createMockModel } from './mock/mock-model'
import { ToolRegistry } from './tools/tool-registry'
import { createToolSearchTool } from './tools/tool-search'
import { agentLoop, type BudgetState } from './agent/loop'
import { pickSearchTool, webFetchTool } from './tools/search-tools'
import { PromptBuilder, PromptContext } from './context/prompt-builder'
import {
  coreRules,
  deferredTools,
  sessionContext,
  toolGuide,
} from './context/prompts'

const deepSeek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const model = process.env.DEEPSEEK_API_KEY
  ? deepSeek.chat('deepseek-v4-flash')
  : createMockModel()

// 工具注册：streamText 通过 tools 参数暴露给模型
const toolRegistry = new ToolRegistry()
toolRegistry.register(...allTools)
toolRegistry.register(pickSearchTool(), webFetchTool)
toolRegistry.register(createToolSearchTool(toolRegistry))

console.log(`已注册 ${toolRegistry.getAll().length} 个工具`)
for (const tool of toolRegistry.getAll()) {
  const flags = [
    tool.isReadOnly ? '只读' : '可写',
    tool.isConcurrencySafe ? '可并发' : '串行',
  ].join(', ')

  console.log(`  - ${tool.name} (${flags})`)
}

// 预算由调用方持有，跨轮持续累积 - agentLoop 只负责消费
const budget: BudgetState = { used: 0, limit: 200_000 }

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
    console.log('\n连接 GitHub MCP Server...')
    try {
      const client = new MCPClient(
        'bunx',
        ['-y', '@modelcontextprotocol/server-github'],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      )
      const tools = await toolRegistry.registerMCPServer('github', client)
      console.log(`已注册 ${tools.length} 个 GitHub MCP 工具`)
      return
    } catch (err) {
      console.log(`MCP 连接失败: ${err instanceof Error ? err.message : err}`)
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，跳过 GitHub MCP Server')
  }
}

async function main() {
  await connectMCP()

  //* 工具统计
  console.log(`\n已注册 ${toolRegistry.getAll().length} 个工具: `)
  for (const tool of toolRegistry.getAll()) {
    const isMCP = tool.name.startsWith('mcp__')
    const flags = [
      isMCP ? 'MCP' : '内置',
      tool.isConcurrencySafe ? '可并发' : '串行',
    ].join(', ')

    console.log(`  - ${tool.name} (${flags})`)
  }

  const allCount = toolRegistry.getAll().length
  const activeTools = toolRegistry.getActiveTools()
  const estimate = toolRegistry.countTokenEstimate()

  console.log('\n=== 工具统计 ===')
  console.log(`全部工具：${allCount}个`)
  console.log(`活跃工具：${activeTools.length}个`)
  console.log(`延迟工具：${estimate.deferred}个`)
  console.log(
    `Token 估算：~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`,
  )

  // 消息历史
  const isContinue = process.argv.includes('--continue')
  const sessionId = 'default'
  const store = new SessionStore(sessionId)

  let messages: ModelMessage[] = []
  if (isContinue && store.exists()) {
    messages = store.load()
    console.log(
      `\n[Session] 恢复会话 "${sessionId}"，${messages.length} 条历史消息`,
    )
  } else {
    console.log(`\n[Session] 新会话 "${sessionId}"`)
  }

  //* 组装 system prompt
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

  // Debug
  builder.debug(promptCtx)

  //* 交互循环
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let rlClosed = false
  rl.on('close', () => {
    rlClosed = true
  })

  const ask = () => {
    if (rlClosed) return

    rl.question('\nYou: ', async (ipt) => {
      const trimmed = ipt.trim()
      if (!trimmed || trimmed.toLowerCase() === 'exit') {
        console.log('Bye!')
        rl.close()
        return
      }

      const beforeCount = messages.length
      const userMessage = {
        role: 'user',
        content: trimmed,
      } satisfies ModelMessage
      messages.push(userMessage)
      await agentLoop({
        model,
        tools: toolRegistry,
        messages,
        system: SYSTEM,
        budget,
      })
      store.appendAll(messages.slice(beforeCount))
      if (!rlClosed) ask()
    })
  }

  console.log('Super Agent v0.7 — Session + Prompt Pipe (type "exit" to quit)')
  console.log('对话会自动保存。用 bun run continue 恢复上次对话。\n')
  ask()
}

main().catch(console.error)
