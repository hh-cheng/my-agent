import 'dotenv/config'
import type { ModelMessage } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ToolRegistry } from '@/tools/tool-registry'
import { agentLoop, type BudgetState } from '@/agent/loop'
import type { ToolDefinition } from '@/tools/tool-registry'
import { applyDefense, estimateMessageTokens } from '@/context/defense'

const deepSeekApiKey = process.env.DEEPSEEK_API_KEY
const runIfDeepSeekKey: typeof test = deepSeekApiKey ? test : test.skip

const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalStdoutWrite = process.stdout.write
const mutedStdoutWrite = (() => true) as typeof process.stdout.write

function outputOf(message: ModelMessage): string {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return ''

  const part = message.content[0]
  if (!('output' in part)) return ''
  if (typeof part.output === 'string') return part.output
  if (
    part.output &&
    typeof part.output === 'object' &&
    'value' in part.output &&
    typeof part.output.value === 'string'
  ) {
    return part.output.value
  }

  return JSON.stringify(part.output)
}

function toolOutputs(messages: ModelMessage[]) {
  return messages
    .filter((message) => message.role === 'tool')
    .map(outputOf)
    .filter(Boolean)
}

function timestampMessages(messages: ModelMessage[]) {
  const now = Date.now()
  return new Map(messages.map((_, index) => [index, now] as const))
}

function createLargePayloadTool(): ToolDefinition {
  return {
    name: 'calculator',
    description:
      '计算数学表达式。当用户要求计算或验证 Agent Loop E2E 防线时必须调用。',
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultChars: 260_000,
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '数学表达式或测试 marker',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    execute: async ({ expression }: { expression: string }) => {
      return [
        `DEFENSE_E2E_HEAD:${expression}`,
        'X'.repeat(210_000),
        `DEFENSE_E2E_TAIL:${expression}`,
      ].join('\n')
    },
  }
}

describe('agentLoop defense E2E', () => {
  beforeEach(() => {
    console.log = () => {}
    console.error = () => {}
    process.stdout.write = mutedStdoutWrite
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
    process.stdout.write = originalStdoutWrite
  })

  runIfDeepSeekKey(
    'uses a real model tool call and applies context defense to loop output',
    async () => {
      if (!deepSeekApiKey) {
        throw new Error('DEEPSEEK_API_KEY is required for this E2E test')
      }

      const deepSeek = createDeepSeek({
        apiKey: deepSeekApiKey,
      })
      const model = deepSeek.chat('deepseek-v4-flash')
      const tools = new ToolRegistry()
      tools.register(createLargePayloadTool())

      const messages: ModelMessage[] = [
        {
          role: 'user',
          content:
            '这是一个 E2E 测试。请必须调用 calculator 工具一次，参数 expression 设为 "agent-loop-defense"。不要自己编造工具结果。',
        },
      ]
      const budget: BudgetState = { used: 0, limit: 1 }

      await agentLoop({
        model,
        tools,
        messages,
        system:
          '你正在执行 Agent Loop E2E 测试。必须调用 calculator 工具；调用后无需继续完成最终总结。',
        budget,
      })

      const rawOutputs = toolOutputs(messages)
      expect(rawOutputs.length).toBeGreaterThan(0)
      expect(rawOutputs.join('\n')).toContain(
        'DEFENSE_E2E_HEAD:agent-loop-defense',
      )
      expect(rawOutputs.join('\n')).toContain(
        'DEFENSE_E2E_TAIL:agent-loop-defense',
      )

      const beforeTokens = estimateMessageTokens(messages)
      const defense = applyDefense(messages, timestampMessages(messages))
      const defendedOutputs = toolOutputs(defense.messages)

      expect(defense.truncated).toBeGreaterThanOrEqual(1)
      expect(defense.estimatedTokens).toBeLessThan(beforeTokens)
      expect(defendedOutputs.join('\n')).toContain('[truncated:')
      expect(defendedOutputs.join('\n')).toContain(
        'DEFENSE_E2E_HEAD:agent-loop-defense',
      )
      expect(defendedOutputs.join('\n')).toContain(
        'DEFENSE_E2E_TAIL:agent-loop-defense',
      )
    },
    60_000,
  )
})
