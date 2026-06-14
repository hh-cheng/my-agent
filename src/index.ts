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

import { ask, type BudgetState } from '@/agent/loop'
import { createMockModel } from '@/mock/mock-model'
import { calculatorTool, weatherTool } from '@/tools/utility-tools'

const deepSeek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const model = process.env.DEEPSEEK_API_KEY
  ? deepSeek.chat('deepseek-chat')
  : createMockModel()

// 工具注册：streamText 通过 tools 参数暴露给模型
const tools = { get_weather: weatherTool, calculator: calculatorTool }

// 消息历史
const messages: ModelMessage[] = []

// 预算由调用方持有，跨轮持续累积 - agentLoop 只负责消费
const budget: BudgetState = { used: 0, limit: 15_000 }

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
})

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`

function promptUser() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim()
    if (!trimmed || trimmed.toLowerCase() === 'exit') {
      console.log('Bye!')
      rl.close()
      return
    }

    messages.push({ role: 'user', content: trimmed })

    await ask({ model, tools, messages, system: SYSTEM })

    promptUser()
  })
}

console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n')
promptUser()
