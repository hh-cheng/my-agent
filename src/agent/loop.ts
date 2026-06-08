import { streamText, type LanguageModel, type ModelMessage } from 'ai'

import type { calculatorTool, weatherTool } from '../tools/utility-tools'

export type AskTools = {
  get_weather: typeof weatherTool
  calculator: typeof calculatorTool
}

export type AskParams = {
  model: LanguageModel
  tools: AskTools
  messages: ModelMessage[]
  system: string
}

const MAX_STEPS = 10

/**
 * 多步 Agent 循环。
 *
 * 每次 iteration 调用一次 streamText（不设 stopWhen），模型可能：
 * 1. 直接输出文本 → 结束
 * 2. 调用工具 → 将 assistant / tool 消息写入 messages，进入下一轮
 *
 * messages 由调用方持有并在循环内原地追加，以跨轮次保留完整对话历史。
 */
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

    // 消费 fullStream 以流式输出文本，并检测本步是否包含工具调用
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
