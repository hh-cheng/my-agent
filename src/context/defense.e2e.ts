import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from 'ai'

import { applyDefense, estimateMessageTokens } from './defense'

function toolMessage(
  toolCallId: string,
  toolName: string,
  output: string,
): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output,
      },
    ],
  } as unknown as ModelMessage
}

function outputOf(message: ModelMessage): string {
  if (message.role !== 'tool' || !Array.isArray(message.content)) return ''

  const part = message.content[0]
  return 'output' in part && typeof part.output === 'string' ? part.output : ''
}

describe('defense E2E', () => {
  test('applies truncation and TTL pruning while preserving error outputs', () => {
    const now = Date.now()
    const messages: ModelMessage[] = [
      { role: 'user', content: '读取几个文件并总结重点' },
      toolMessage(
        'recent-big',
        'read_file',
        `HEAD\n${'A'.repeat(210_000)}\nTAIL`,
      ),
      toolMessage(
        'soft-old',
        'grep',
        `SOFT-HEAD\n${'B'.repeat(5_000)}\nSOFT-TAIL`,
      ),
      toolMessage(
        'hard-old',
        'read_file',
        `HARD-HEAD\n${'C'.repeat(5_000)}\nHARD-TAIL`,
      ),
      toolMessage(
        'old-error',
        'read_file',
        'timeout: upstream tool did not respond in time',
      ),
      { role: 'assistant', content: '我已经读取了这些结果。' },
    ]
    const timestamps = new Map<number, number>([
      [0, now],
      [1, now - 60 * 1000],
      [2, now - 7 * 60 * 1000],
      [3, now - 12 * 60 * 1000],
      [4, now - 12 * 60 * 1000],
      [5, now],
    ])

    const beforeTokens = estimateMessageTokens(messages)
    const defense = applyDefense(messages, timestamps)
    const afterTokens = estimateMessageTokens(defense.messages)

    expect(defense.messages).toHaveLength(messages.length)
    expect(defense.estimatedTokens).toBe(afterTokens)
    expect(defense.estimatedTokens).toBeLessThan(beforeTokens)

    expect(defense.truncated).toBe(1)
    expect(outputOf(defense.messages[1])).toContain('[truncated:')
    expect(outputOf(defense.messages[1])).toContain('HEAD')
    expect(outputOf(defense.messages[1])).toContain('TAIL')

    expect(defense.softPruned).toBe(1)
    expect(outputOf(defense.messages[2])).toContain('[soft pruned:')
    expect(outputOf(defense.messages[2])).toContain('SOFT-HEAD')
    expect(outputOf(defense.messages[2])).toContain('SOFT-TAIL')

    expect(defense.hardPruned).toBe(1)
    expect(outputOf(defense.messages[3])).toBe(
      '[tool result expired: read_file]',
    )

    expect(outputOf(defense.messages[4])).toBe(
      'timeout: upstream tool did not respond in time',
    )
  })

  test('compacts oldest tool results when total context exceeds the budget', () => {
    const now = Date.now()
    const messages: ModelMessage[] = [
      { role: 'user', content: '读取大量文件' },
      toolMessage('big-1', 'read_file', 'A'.repeat(210_000)),
      toolMessage('big-2', 'read_file', 'B'.repeat(210_000)),
      toolMessage('big-3', 'read_file', 'C'.repeat(210_000)),
      toolMessage('big-4', 'read_file', 'D'.repeat(210_000)),
      toolMessage('big-5', 'read_file', 'E'.repeat(210_000)),
    ]
    const timestamps = new Map(
      messages.map((_, index) => [index, now] as const),
    )

    const beforeTokens = estimateMessageTokens(messages)
    const defense = applyDefense(messages, timestamps)

    expect(defense.estimatedTokens).toBeLessThan(beforeTokens)
    expect(defense.truncated).toBe(5)
    expect(defense.compacted).toBeGreaterThan(0)
    expect(
      defense.messages.some((msg) => outputOf(msg).includes('[compacted:')),
    ).toBe(true)
  })
})
