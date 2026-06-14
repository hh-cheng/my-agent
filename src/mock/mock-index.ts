import 'dotenv/config'
import { streamText } from 'ai'
import { createInterface } from 'node:readline'
import { createDeepSeek } from '@ai-sdk/deepseek'

import { createMockModel } from '@/mock/mock-model'
import { weatherTool, calculatorTool } from '@/tools/utility-tools'

type ModelMessage = NonNullable<
  Parameters<typeof streamText>[0]['messages']
>[number]

;(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false

const deepSeek = createDeepSeek({
  apiKey: process.env.DEEPSEEK_API_KEY,
})

const model = process.env.DEEPSEEK_API_KEY
  ? deepSeek.chat('deepseek-chat')
  : createMockModel()

//* 非流式输出
// async function main() {
//   const { text } = await generateText({ model, prompt: '用一句话介绍你自己' })
//   console.log(text)
// }

//* 流式输出
// async function main() {
//   const result = streamText({ model, prompt: '用一句话介绍你自己' })
//   for await (const chunk of result.textStream) {
//     process.stdout.write(chunk)
//   }
// }

// main()

//* 读取用户输入
const systemPrompt = `
你是 Super Agent，一个专注于软件开发的 AI 助手。
你说话简介直接，喜欢用代码示例来解释问题。
如果用户的问题不够清晰，你会反问而不是瞎猜。
`.trim()

const rl = createInterface({
  input: process.stdin,
  terminal: false,
})

const messages: ModelMessage[] = []

function shutdown() {
  console.log('Bye!')
  rl.close()
  process.stdin.pause()
  process.exitCode = 0
}

async function writeTextStream(stream: AsyncIterable<string>) {
  let pending = ''
  let lastFlush = Date.now()

  for await (const chunk of stream) {
    pending += chunk

    const shouldFlush =
      Date.now() - lastFlush > 50 || /[。！？.!?\n]$/.test(pending)

    if (shouldFlush) {
      process.stdout.write(pending)
      pending = ''
      lastFlush = Date.now()
    }
  }

  if (pending) {
    process.stdout.write(pending)
  }
}

async function main() {
  console.log('Super Agent v0.1 (type "exit" to quit)\n')
  process.stdout.write('You: ')

  for await (const input of rl) {
    const trimmed = input.trim()
    if (!trimmed || trimmed === 'exit') {
      shutdown()
      return
    }

    messages.push({ role: 'user', content: trimmed })
    const tools = { get_weather: weatherTool, calculator: calculatorTool }

    const result = streamText({ model, messages, system: systemPrompt, tools })

    process.stdout.write('Assistant: ')
    let fullResponse = ''
    const responseStream = new TransformStream<string, string>({
      transform(chunk, controller) {
        fullResponse += chunk
        controller.enqueue(chunk)
      },
    })

    await writeTextStream(result.textStream.pipeThrough(responseStream))

    if (!fullResponse.endsWith('\n')) {
      process.stdout.write('\n')
    }

    messages.push({ role: 'assistant', content: fullResponse })

    process.stdout.write('\nYou: ')
  }
}

main().catch((error) => {
  console.error(error)
  rl.close()
  process.stdin.pause()
  process.exitCode = 1
})
