import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ModelMessage } from 'ai'

const generateTextMock = mock()
const streamTextMock = mock()
const originalConsoleError = console.error

mock.module('ai', () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

const { estimateTokens, microCompact, summarize } = await import('./compressor')

function toolMessage(toolName: string, output: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName,
        toolCallId: `${toolName}-call`,
        output,
      },
    ],
  } as ModelMessage
}

function longText(label: string) {
  return `${label} ${'x'.repeat(320)}`
}

describe('microCompact', () => {
  test('clears only older clearable tool results and keeps the latest three', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'start' },
      toolMessage('read_file', { file: 'a.ts', content: 'old read' }),
      toolMessage('web_fetch', { html: 'old fetch should remain' }),
      toolMessage('bash', { stdout: 'old bash' }),
      toolMessage('grep', { matches: ['recent grep'] }),
      toolMessage('glob', { files: ['recent glob'] }),
      toolMessage('list_directory', { entries: ['recent list'] }),
    ]

    const result = microCompact(messages)

    expect(result.cleared).toBe(2)
    expect((result.messages[1].content as any[])[0].output).toBe(
      '[tool result cleared]',
    )
    expect((result.messages[2].content as any[])[0].output).toEqual({
      html: 'old fetch should remain',
    })
    expect((result.messages[3].content as any[])[0].output).toBe(
      '[tool result cleared]',
    )
    expect((result.messages[4].content as any[])[0].output).toEqual({
      matches: ['recent grep'],
    })
    expect((result.messages[5].content as any[])[0].output).toEqual({
      files: ['recent glob'],
    })
    expect((result.messages[6].content as any[])[0].output).toEqual({
      entries: ['recent list'],
    })
  })

  test('does nothing when there are no older tool results to clear', () => {
    const messages: ModelMessage[] = [
      toolMessage('read_file', { content: 'one' }),
      toolMessage('bash', { stdout: 'two' }),
      toolMessage('grep', { matches: ['three'] }),
    ]

    const result = microCompact(messages)

    expect(result.cleared).toBe(0)
    expect(result.messages).toEqual(messages)
  })
})

describe('summarize', () => {
  beforeEach(() => {
    generateTextMock.mockReset()
    console.error = mock(() => {})
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  test('skips summarization below the token or message threshold', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'ok' },
    ]

    const result = await summarize({} as never, messages, 'existing summary')

    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      messages,
      summary: 'existing summary',
      compressedCount: 0,
    })
  })

  test('compresses older messages and keeps the recent user-aligned window', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: longText('u0') },
      { role: 'assistant', content: longText('a1') },
      { role: 'user', content: longText('u2') },
      { role: 'assistant', content: longText('a3') },
      { role: 'user', content: longText('u4') },
      { role: 'assistant', content: longText('a5') },
      { role: 'user', content: longText('u6') },
      { role: 'assistant', content: longText('a7') },
      { role: 'user', content: longText('u8') },
    ]

    generateTextMock.mockResolvedValueOnce({ text: 'new compact summary' })

    const result = await summarize({ id: 'model' } as never, messages)

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    expect(generateTextMock.mock.calls[0][0]).toMatchObject({
      model: { id: 'model' },
    })
    expect(generateTextMock.mock.calls[0][0].prompt).toContain('**user**\nu0 ')
    expect(generateTextMock.mock.calls[0][0].prompt).toContain(
      '**assistant**\na1 ',
    )
    expect(result.summary).toBe('new compact summary')
    expect(result.compressedCount).toBe(2)
    expect(result.messages).toEqual([
      {
        role: 'user',
        content:
          '[以下是之前对话的压缩摘要]\n\nnew compact summary\n\n[摘要结束，以下是最近的对话]',
      },
      ...messages.slice(2),
    ])
  })

  test('includes the existing summary when compacting more history', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: longText('u0') },
      { role: 'assistant', content: longText('a1') },
      { role: 'user', content: longText('u2') },
      { role: 'assistant', content: longText('a3') },
      { role: 'user', content: longText('u4') },
      { role: 'assistant', content: longText('a5') },
      { role: 'user', content: longText('u6') },
      { role: 'assistant', content: longText('a7') },
      { role: 'user', content: longText('u8') },
    ]

    generateTextMock.mockResolvedValueOnce({ text: 'merged summary' })

    const result = await summarize(
      {} as never,
      messages,
      'previous compact summary',
    )

    expect(generateTextMock.mock.calls[0][0].prompt).toContain(
      '## 已有摘要（上一次压缩的结果）\n\nprevious compact summary\n\n## 需要压缩的新对话',
    )
    expect(generateTextMock.mock.calls[0][0].prompt).toContain('**user**\nu0 ')
    expect(generateTextMock.mock.calls[0][0].prompt).toContain(
      '**assistant**\na1 ',
    )
    expect(result.summary).toBe('merged summary')
  })

  test('keeps the original messages when summary generation fails', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: longText('u0') },
      { role: 'assistant', content: longText('a1') },
      { role: 'user', content: longText('u2') },
      { role: 'assistant', content: longText('a3') },
      { role: 'user', content: longText('u4') },
      { role: 'assistant', content: longText('a5') },
      { role: 'user', content: longText('u6') },
      { role: 'assistant', content: longText('a7') },
      { role: 'user', content: longText('u8') },
    ]

    generateTextMock.mockRejectedValueOnce(new Error('model failed'))

    const result = await summarize({} as never, messages, 'old summary')

    expect(result).toEqual({
      messages,
      summary: 'old summary',
      compressedCount: 0,
    })
    expect(console.error).toHaveBeenCalled()
  })
})

describe('estimateTokens', () => {
  test('estimates string, text-part, and output-part content', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: '12345678' },
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'abcd' },
          {
            type: 'tool-result',
            toolCallId: 'call',
            toolName: 'bash',
            output: { type: 'json', value: 1 },
          },
        ],
      } as ModelMessage,
    ]

    expect(estimateTokens(messages)).toBe(10)
  })
})
