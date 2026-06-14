import type { LanguageModel } from 'ai'

type MockModel = Extract<LanguageModel, { specificationVersion: 'v2' }>
type MockCallOptions = Parameters<MockModel['doGenerate']>[0]
type MockStreamPart =
  Awaited<ReturnType<MockModel['doStream']>>['stream'] extends ReadableStream<
    infer Chunk
  >
    ? Chunk
    : never

const RESPONSES = {
  default:
    '你好！我是模拟模型。填了 DEEPSEEK_API_KEY 后会自动切换到真实的 DeepSeek。',
  greeting: '你好！虽然是模拟的，但流式输出的效果和真实 API 一致 :)',
  name: '你刚才告诉我了呀！我能"记住"是因为代码把对话历史传给了我。',
  intro: '我是 DeepSeek（模拟版），在本地模拟回复，机制和真实 API 完全一致。',
}

const USAGE = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
}

function pickResponse(prompt: MockCallOptions['prompt']): string {
  const userMsgs = (prompt || []).filter((m) => m.role === 'user')
  const last = userMsgs[userMsgs.length - 1]
  const text = (last?.content || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .toLowerCase()

  if (text.includes('介绍你自己') || text.includes('你是谁'))
    return RESPONSES.intro
  if (text.includes('你好') || text.includes('hello')) return RESPONSES.greeting
  if (text.includes('叫什么') || text.includes('记住')) return RESPONSES.name
  return RESPONSES.default
}

function createDelayedStream(
  chunks: MockStreamPart[],
  delayMs = 30,
): Awaited<ReturnType<MockModel['doStream']>>['stream'] {
  return new ReadableStream({
    start(controller) {
      let i = 0
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++])
          setTimeout(next, delayMs)
        } else {
          controller.close()
        }
      }
      next()
    },
  })
}

export function createMockModel(): MockModel {
  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'mock-model',

    supportedUrls: {},

    async doGenerate({ prompt }: MockCallOptions) {
      return {
        usage: USAGE,
        warnings: [],
        finishReason: 'stop',
        content: [{ type: 'text', text: pickResponse(prompt) }],
      }
    },

    async doStream({ prompt }: MockCallOptions) {
      const text = pickResponse(prompt)
      const id = 'text-1'
      const chunks: MockStreamPart[] = [
        { type: 'text-start', id },
        ...text.split('').map(
          (char): MockStreamPart => ({
            type: 'text-delta',
            id,
            delta: char,
          }),
        ),
        { type: 'text-end', id },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: USAGE,
        },
      ]

      return { stream: createDelayedStream(chunks) }
    },
  }
}
