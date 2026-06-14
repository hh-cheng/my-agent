import { streamText, type LanguageModel, type ModelMessage } from 'ai'

import type { ToolRegistry } from '@/tools/tool-registry'
import { calculateDelay, isRetryable, sleep } from './retry'
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from './loop-detection'

export type BudgetState = {
  used: number
  limit: number
}

export type LoopParams = {
  model: LanguageModel
  tools: ToolRegistry
  messages: ModelMessage[]
  system: string
  budget: BudgetState
}

export type AgentLoopParams = {
  model: LanguageModel
  tools: ToolRegistry
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

    let fullText = ''
    let hasToolCall = false
    let shouldBreak = false
    let lastToolCall: { name: string; input: unknown } | null = null
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>

    for (let attempt = 1; ; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          messages,
          maxRetries: 0,
          tools: tools.toAISDKFormat(),
          onError: () => {},
        })

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
                `[调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
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
              const output =
                typeof part.output === 'string'
                  ? part.output
                  : JSON.stringify(part.output, null, 2)
              const preview =
                output.length > 120 ? output.slice(0, 120) + '...' : output
              console.log(`[结果: ${part.toolName}] ${preview}`)
              if (lastToolCall) {
                recordResult(lastToolCall.name, lastToolCall.input, part.output)
              }
              break
            }
          }
        }

        stepUsage = await result.usage
        stepResponse = await result.response
        break
      } catch (err) {
        if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err
        const delay = calculateDelay(attempt)
        console.log(
          `\n[重试] 第${attempt}/${MAX_RETRIES}次失败，${delay}ms后重试...`,
        )
        await sleep(delay)
        fullText = ''
        hasToolCall = false
        shouldBreak = false
        lastToolCall = null
      }
    }

    if (shouldBreak) {
      console.log('\n[检测到循环调用， Agent 已停止]')
      break
    }

    messages.push(...stepResponse.messages)

    //* Token 预算追踪
    const take = stepUsage.inputTokens ?? 0
    const out = stepUsage.outputTokens ?? 0
    budget.used += take + out
    const percentage = Math.round((budget.used / budget.limit) * 100)
    console.log(
      `\n\n[预算] ${budget.used}→${budget.limit} tokens，使用率 ${percentage}%`,
    )
    if (budget.used > budget.limit) {
      console.log('\n[预算超支，强制停止]')
      break
    }

    //* 无工具调用 = 模型已给出最终回复
    if (!hasToolCall) {
      if (fullText) console.log()
      break
    }

    console.log('\n→ 模型还在工作，继续下一步...')
  }

  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]')
  }
}
