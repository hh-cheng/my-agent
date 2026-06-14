import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ModelMessage } from 'ai'

const streamTextMock = mock()
const isRetryableMock = mock(
  (error: unknown): boolean => error instanceof Error,
)
const calculateDelayMock = mock(() => 0)
const sleepMock = mock(async () => {})
const originalConsoleLog = console.log
const originalStdoutWrite = process.stdout.write

mock.module('ai', () => ({
  streamText: streamTextMock,
}))

mock.module('./retry', () => ({
  calculateDelay: calculateDelayMock,
  isRetryable: isRetryableMock,
  sleep: sleepMock,
}))

const { agentLoop } = await import('./loop')

const testTools = {
  toAISDKFormat: () => ({}),
}

function streamResult(
  parts: unknown[],
  messages: ModelMessage[] = [],
  usage = { inputTokens: 0, outputTokens: 0 },
) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })(),
    usage: Promise.resolve(usage),
    response: Promise.resolve({ messages }),
  }
}

function failingStream(error: Error) {
  return {
    fullStream: (async function* () {
      throw error
    })(),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
    response: Promise.resolve({ messages: [] }),
  }
}

describe('agentLoop API retry', () => {
  beforeEach(() => {
    console.log = mock(() => {})
    process.stdout.write = mock(() => true) as typeof process.stdout.write

    streamTextMock.mockReset()
    isRetryableMock.mockReset()
    calculateDelayMock.mockReset()
    sleepMock.mockReset()

    isRetryableMock.mockImplementation(
      (error: unknown): boolean => error instanceof Error,
    )
    calculateDelayMock.mockImplementation(() => 0)
    sleepMock.mockImplementation(async () => {})
  })

  afterEach(() => {
    console.log = originalConsoleLog
    process.stdout.write = originalStdoutWrite
  })

  test('retries retryable API failures and keeps the successful response', async () => {
    const messages: ModelMessage[] = []
    const finalMessage = {
      role: 'assistant',
      content: 'done',
    } satisfies ModelMessage

    streamTextMock
      .mockImplementationOnce(() => {
        throw new Error('HTTP 500')
      })
      .mockImplementationOnce(() =>
        streamResult([{ type: 'text-delta', text: 'done' }], [finalMessage]),
      )

    await agentLoop({
      model: {} as never,
      tools: testTools as never,
      messages,
      system: 'test',
      budget: { used: 0, limit: 100 },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(isRetryableMock).toHaveBeenCalledTimes(1)
    expect(calculateDelayMock).toHaveBeenCalledWith(1)
    expect(sleepMock).toHaveBeenCalledWith(0)
    expect(messages).toEqual([finalMessage])
  })

  test('retries failures thrown while consuming the stream', async () => {
    const messages: ModelMessage[] = []
    const finalMessage = {
      role: 'assistant',
      content: 'stream recovered',
    } satisfies ModelMessage

    streamTextMock
      .mockImplementationOnce(() => failingStream(new Error('fetch failed')))
      .mockImplementationOnce(() =>
        streamResult(
          [{ type: 'text-delta', text: 'stream recovered' }],
          [finalMessage],
        ),
      )

    await agentLoop({
      model: {} as never,
      tools: testTools as never,
      messages,
      system: 'test',
      budget: { used: 0, limit: 100 },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(sleepMock).toHaveBeenCalledTimes(1)
    expect(messages).toEqual([finalMessage])
  })

  test('does not retry non-retryable API failures', async () => {
    const error = new Error('HTTP 400')
    isRetryableMock.mockImplementation(() => false)
    streamTextMock.mockImplementationOnce(() => {
      throw error
    })

    await expect(
      agentLoop({
        model: {} as never,
        tools: testTools as never,
        messages: [],
        system: 'test',
        budget: { used: 0, limit: 100 },
      }),
    ).rejects.toThrow(error)

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  test('stops retrying after the retry limit', async () => {
    const error = new Error('HTTP 529')
    streamTextMock.mockImplementation(() => {
      throw error
    })

    await expect(
      agentLoop({
        model: {} as never,
        tools: testTools as never,
        messages: [],
        system: 'test',
        budget: { used: 0, limit: 100 },
      }),
    ).rejects.toThrow(error)

    expect(streamTextMock).toHaveBeenCalledTimes(3)
    expect(isRetryableMock).toHaveBeenCalledTimes(2)
    expect(sleepMock).toHaveBeenCalledTimes(2)
  })
})

describe('agentLoop budget guard', () => {
  beforeEach(() => {
    console.log = mock(() => {})
    process.stdout.write = mock(() => true) as typeof process.stdout.write

    streamTextMock.mockReset()
    isRetryableMock.mockReset()
    calculateDelayMock.mockReset()
    sleepMock.mockReset()

    isRetryableMock.mockImplementation(
      (error: unknown): boolean => error instanceof Error,
    )
    calculateDelayMock.mockImplementation(() => 0)
    sleepMock.mockImplementation(async () => {})
  })

  afterEach(() => {
    console.log = originalConsoleLog
    process.stdout.write = originalStdoutWrite
  })

  test('accumulates usage and continues while the budget remains available', async () => {
    const budget = { used: 3, limit: 30 }
    const messages: ModelMessage[] = []
    const toolMessage = {
      role: 'assistant',
      content: 'calling calculator',
    } satisfies ModelMessage
    const finalMessage = {
      role: 'assistant',
      content: 'done',
    } satisfies ModelMessage

    streamTextMock
      .mockImplementationOnce(() =>
        streamResult(
          [
            {
              type: 'tool-call',
              toolName: 'calculator',
              input: { expression: '1 + 1' },
            },
            { type: 'tool-result', output: { value: 2 } },
          ],
          [toolMessage],
          { inputTokens: 8, outputTokens: 4 },
        ),
      )
      .mockImplementationOnce(() =>
        streamResult([{ type: 'text-delta', text: 'done' }], [finalMessage], {
          inputTokens: 2,
          outputTokens: 1,
        }),
      )

    await agentLoop({
      model: {} as never,
      tools: testTools as never,
      messages,
      system: 'test',
      budget,
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(budget.used).toBe(18)
    expect(messages).toEqual([toolMessage, finalMessage])
  })

  test('stops before another model call when usage exceeds the budget', async () => {
    const budget = { used: 10, limit: 20 }
    const messages: ModelMessage[] = []
    const toolMessage = {
      role: 'assistant',
      content: 'calling calculator',
    } satisfies ModelMessage

    streamTextMock.mockImplementationOnce(() =>
      streamResult(
        [
          {
            type: 'tool-call',
            toolName: 'calculator',
            input: { expression: '1 + 1' },
          },
          { type: 'tool-result', output: { value: 2 } },
        ],
        [toolMessage],
        { inputTokens: 8, outputTokens: 5 },
      ),
    )

    await agentLoop({
      model: {} as never,
      tools: testTools as never,
      messages,
      system: 'test',
      budget,
    })

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(budget.used).toBe(23)
    expect(messages).toEqual([toolMessage])
  })
})
