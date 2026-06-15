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

import { allTools } from './tools/utility-tools'
import { createMockModel } from './mock/mock-model'
import { ToolRegistry } from './tools/tool-registry'
import { agentLoop, type BudgetState } from './agent/loop'
import { pickSearchTool, webFetchTool } from './tools/search-tools'

const deepSeek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const model = process.env.DEEPSEEK_API_KEY
  ? deepSeek.chat('deepseek-v4-flash')
  : createMockModel()

// 工具注册：streamText 通过 tools 参数暴露给模型
const toolRegistry = new ToolRegistry()
toolRegistry.registry(...allTools)
toolRegistry.registry(pickSearchTool(), webFetchTool)

console.log(`已注册 ${toolRegistry.getAll().length} 个工具`)
for (const tool of toolRegistry.getAll()) {
  const flags = [
    tool.isReadOnly ? '只读' : '可写',
    tool.isConcurrencySafe ? '可并发' : '串行',
  ].join(', ')

  console.log(`  - ${tool.name} (${flags})`)
}

// 消息历史
const messages: ModelMessage[] = []

// 预算由调用方持有，跨轮持续累积 - agentLoop 只负责消费
const budget: BudgetState = { used: 0, limit: 200_000 }

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息或操作文件时，主动使用工具，不要编造数据。
可以同时调用多个互不冲突的工具来提高效率。
回答要简洁直接。`

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed.toLowerCase() === 'exit') {
      console.log('Bye!')
      rl.close()
      return
    }

    messages.push({ role: 'user', content: trimmed })

    await agentLoop({
      model,
      tools: toolRegistry,
      messages,
      system: SYSTEM,
      budget,
    })

    ask()
  })
}

console.log('Super Agent v0.4 — Tool System (type "exit" to quit)')
console.log(
  '试试："帮我看看当前目录"、"读取 package.json"、"测试并发"、"测试截断"\n',
)

ask()
