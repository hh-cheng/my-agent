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

function streamResult(parts: unknown[], messages: ModelMessage[] = []) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })(),
    response: Promise.resolve({ messages }),
  }
}

function failingStream(error: Error) {
  return {
    fullStream: (async function* () {
      throw error
    })(),
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
      tools: {} as never,
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
      tools: {} as never,
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
        tools: {} as never,
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
        tools: {} as never,
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
