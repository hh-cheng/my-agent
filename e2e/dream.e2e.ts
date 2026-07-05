import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { MemoryStore } from '@/memory/store'
import { PromptBuilder } from '@/context/prompt-builder'

const streamTextMock = mock()
const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalStdoutWrite = process.stdout.write

mock.module('ai', () => ({
  jsonSchema: (schema: unknown) => schema,
  streamText: streamTextMock,
}))

const { createDispatcher } = await import('@/commands')
const { memoryCommands } = await import('@/commands/memory')
const { createMemoryTool } = await import('@/tools/memory-tools')

let tempDirs: string[] = []

afterEach(async () => {
  console.log = originalConsoleLog
  console.error = originalConsoleError
  process.stdout.write = originalStdoutWrite
  streamTextMock.mockReset()

  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
})

beforeEach(() => {
  console.log = mock(() => {})
  console.error = mock(() => {})
  process.stdout.write = mock(() => true) as typeof process.stdout.write
})

async function createStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dream-e2e-'))
  tempDirs.push(dir)
  const store = new MemoryStore(dir)
  await store.init()
  return store
}

function textStream(text: string) {
  return {
    fullStream: (async function* () {
      yield { type: 'text-delta', text }
    })(),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    response: Promise.resolve({
      messages: [{ role: 'assistant', content: text }],
    }),
  }
}

function toolStream(
  toolName: string,
  input: unknown,
  outputPromise: Promise<unknown>,
  messageContent: string,
) {
  return {
    fullStream: (async function* () {
      const output = await outputPromise
      yield { type: 'tool-call', toolName, input }
      yield { type: 'tool-result', toolName, output }
    })(),
    usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    response: Promise.resolve({
      messages: [
        {
          role: 'assistant',
          content: messageContent,
        },
      ],
    }),
  }
}

describe('dream command E2E', () => {
  test('runs the dream prompt through agentLoop and deletes stale memory', async () => {
    const store = await createStore()
    const staleFilename = await store.save({
      name: 'Obsolete deploy note',
      description: 'References a missing deploy script',
      type: 'project',
      content: 'Old deploy flow depends on ./missing-dream-e2e.sh.',
    })
    const memoryTool = createMemoryTool(store)
    const messages: ModelMessage[] = []
    const appended: ModelMessage[] = []

    const registry = {
      getDeferredToolSummary: () => '',
      toAISDKFormat: () => ({
        memory: {
          execute: memoryTool.execute,
        },
      }),
    }

    streamTextMock
      .mockImplementationOnce(({ tools }: any) => {
        const input = { action: 'lint' }
        const output = tools.memory.execute(input).then((result: unknown) => {
          expect(String(result)).toContain(staleFilename)
          expect(String(result)).toContain('stale_path')
          return result
        })
        return toolStream('memory', input, output, 'linted memory')
      })
      .mockImplementationOnce(({ tools }: any) => {
        const input = { action: 'delete', filename: staleFilename }
        const output = tools.memory.execute(input)
        return toolStream('memory', input, output, 'deleted stale memory')
      })
      .mockImplementationOnce(() =>
        textStream('dream 完成：删除了引用过期路径的记忆。'),
      )

    const dispatch = createDispatcher(memoryCommands)
    const handled = await dispatch('/dream', {
      model: {} as never,
      modelName: 'Mock',
      modelId: 'mock-dream-e2e',
      budget: { used: 0, limit: 100 },
      tracker: undefined,
      registry,
      builder: new PromptBuilder(),
      messages,
      memoryStore: store,
      sessionStore: {
        appendAll: (newMessages: ModelMessage[]) =>
          appended.push(...newMessages),
      },
      timestamps: new Map<number, number>(),
      ask: () => {},
      makePromptCtx: () => ({
        sessionId: 'dream-e2e',
        sessionMessageCount: messages.length,
        toolCount: 1,
        deferredToolSummary: '',
      }),
    } as any)

    expect(handled).toBe(true)
    expect(streamTextMock).toHaveBeenCalledTimes(3)
    expect(await store.loadFile(staleFilename)).toBeNull()
    expect(messages[0]).toMatchObject({ role: 'user' })
    expect(String(messages[0].content)).toContain('完整的整理（dream）')
    expect(appended).toEqual(messages)
  })
})
