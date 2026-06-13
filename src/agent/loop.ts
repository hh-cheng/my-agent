import { streamText, type LanguageModel, type ModelMessage } from 'ai'

import type { calculatorTool, weatherTool } from '../tools/utility-tools'
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from './loop-detection'

export type AskTools = {
  get_weather: typeof weatherTool
  calculator: typeof calculatorTool
}

export type BudgetState = {
  used: number
  limit: number
}

export type AskParams = {
  model: LanguageModel
  tools: AskTools
  messages: ModelMessage[]
  system: string
}

export type AgentLoopParams = {
  model: LanguageModel
  tools: AskTools
  messages: ModelMessage[]
  system: string
  budget: BudgetState
}

const MAX_STEPS = 15
const MAX_RETRIES = 3

// 带循环检测的 Agent 主循环；调用方传入的 messages 会被原地追加。
export async function agentLoop(params: AgentLoopParams) {
  const { model, tools, messages, system, budget } = params

  let step = 0
  resetHistory()

  while (step++ < MAX_STEPS) {
    console.log(`\n--- Step ${step} ---`)

    const result = streamText({
      model,
      system,
      tools,
      messages,
      maxRetries: 0,
      onError: () => {},
    })

    let fullText = ''
    let hasToolCall = false
    let shouldBreak = false
    let lastToolCall: { name: string; input: unknown } | null = null

    // fullStream 同时暴露文本、工具调用和工具结果，便于逐步记录状态。
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          process.stdout.write(part.text)
          fullText += part.text
          break
        }

        case 'tool-call': {
          hasToolCall = true
          lastToolCall = { name: part.toolName, input: part.input }
          console.log(
            `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
          )

          const detection = detect(part.toolName, part.input)
          if (detection.stuck) {
            console.log(`  ${detection.message}`)
            if (detection.level === 'critical') {
              shouldBreak = true
            } else {
              messages.push({
                role: 'user',
                content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
              })
            }
          }
          recordCall(part.toolName, part.input)
          break
        }

        case 'tool-result': {
          console.log(`  [结果: ${JSON.stringify(part.output)}]`)
          if (lastToolCall) {
            recordResult(lastToolCall.name, lastToolCall.input, part.output)
          }
          break
        }
      }

      if (shouldBreak) {
        console.log('\n[检测到循环调用， Agent 已停止]')
        break
      }

      const stepResult = await result.response
      messages.push(...stepResult.messages)

      if (!hasToolCall) {
        if (fullText) console.log()
        break
      }

      console.log('  → 模型还在工作，继续下一步...')
    }
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]')
  }
}

// 简化版 Agent Loop：模型没有工具调用时结束，有工具调用时追加消息并进入下一轮。
export async function ask({ model, tools, messages, system }: AskParams) {
  let step = 0

  while (step < MAX_STEPS) {
    step++
    console.log(`\n--- Step ${step} ---`)

    const result = streamText({
      model,
      system,
      tools,
      messages,
      // 不设 stopWhen：由本循环决定何时结束，而非 SDK 自动跑完所有 tool step
    })

    let hasToolCall = false
    let fullText = ''

    // fullStream 替代 textStream：除 text-delta 外，还能收到 tool-call / tool-result
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text)
          fullText += part.text
          break

        case 'tool-call':
          hasToolCall = true
          console.log(
            `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
          )
          break

        case 'tool-result':
          console.log(`  [结果: ${JSON.stringify(part.output)}]`)
          break
      }
    }

    // response.messages 包含本步的 assistant 消息及 tool-result，供下一轮 model 读取
    const stepMessages = await result.response
    messages.push(...stepMessages.messages)

    // 无工具调用 = 模型已给出最终回复
    if (!hasToolCall) {
      if (fullText) console.log()
      break
    }

    console.log('  → 模型还在工作，继续下一步...')
  }

  // 防止工具调用死循环（如模型反复调用同一工具）
  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]')
  }
}
