import 'dotenv/config'
import { type ModelMessage } from 'ai'
import { createInterface } from 'node:readline'
import { createDeepSeek } from '@ai-sdk/deepseek'

import { ask } from './agent/loop'
import { createMockModel } from './mock-model'
import { calculatorTool, weatherTool } from './tools/utility-tools'

const deepSeek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const model = process.env.DEEPSEEK_API_KEY
  ? deepSeek.chat('deepseek-chat')
  : createMockModel()

const tools = { get_weather: weatherTool, calculator: calculatorTool }

const messages: ModelMessage[] = []

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
