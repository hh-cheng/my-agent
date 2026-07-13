import { type LanguageModel, type ModelMessage, streamText } from 'ai'

import type { SpawnRequest } from './types'
import type { SubAgentRegistry } from './registry'
import type { ToolRegistry } from '@/tools/tool-registry'
import { logger } from '@/logging'

export interface SpawnContext {
  currentDepth: number
  model: LanguageModel
  registry: ToolRegistry
  agentRegistry: SubAgentRegistry

  buildSystem: () => string | Promise<string>
}

const EXCLUDED_TOOLS = new Set(['spawn_agent'])

const RESET = '\x1b[0m'
const AGENT_COLORS = [
  '\x1b[36m', // cyan
  '\x1b[33m', // yellow
  '\x1b[35m', // magenta
  '\x1b[32m', // green
  '\x1b[34m', // blue
]

function agentTag(index: number, runId: string) {
  const color = AGENT_COLORS[index % AGENT_COLORS.length]
  return `${color}[Agent-${index + 1}]${RESET}`
}

export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
) {
  const { ok, reason } = ctx.agentRegistry.canSpawn(ctx.currentDepth)
  if (!ok) return `[spawn] 拒绝: ${reason}`

  const runId = ctx.agentRegistry.generateId()
  const tag = agentTag(index, runId)
  const run: Parameters<typeof ctx.agentRegistry.register>[0] = {
    id: runId,
    status: 'running',
    task: request.task,
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  }
  ctx.agentRegistry.register(run)

  const maxSteps = 30
  const timeout = request.timeout || 60_000
  const ac = new AbortController()
  logger.info(`${tag} 启动: ${request.task.slice(0, 50)}`)

  const messages: ModelMessage[] = [{ role: 'user', content: request.task }]

  try {
    const system =
      (await ctx.buildSystem()) +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。'

    //! toAISDKFormatUnlocked 绕过父 Agent 的读写锁
    const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS)
    const timer = setTimeout(ac.abort, timeout)

    try {
      let step = 0
      while (step < maxSteps) {
        step++
        const isLastStep = step === maxSteps
        logger.info(
          `${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`,
        )
        if (isLastStep) {
          messages.push({
            role: 'user',
            content:
              '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。',
          })
        }

        //! 这里不用 agentLoop 是因为工具调用的 toolRegistry.toAISDKFormat() 这个方法会走读写锁，又因为 spawn_agent 本身是一个工具
        //! 执行时父 Agent 的锁还没释放，所以子 Agent 再调工具会锁死
        const result = streamText({
          model: ctx.model,
          tools,
          system,
          messages,
          maxRetries: 0,
          abortSignal: ac.signal,
          toolChoice: isLastStep ? 'none' : 'auto',
          providerOptions: { openai: { parallelToolCalls: true } },
          onError: () => {},
        })
        let hasToolCall = false

        for await (const part of result.fullStream) {
          if (part.type === 'tool-call') {
            hasToolCall = true
            const argsPreview = JSON.stringify(part.input).slice(0, 80)
            logger.raw(`${tag} 调用 ${part.toolName}(${argsPreview})`)
          }
        }

        const response = await result.response
        messages.push(...response.messages)
        if (!hasToolCall) break
      }
    } finally {
      clearTimeout(timer)
    }

    // 提取最后一条 assistant 消息作为结果
    const lastAssistant = [...messages.reverse()].find(
      (m) => m.role === 'assistant',
    )
    let result = '(无输出)'
    if (lastAssistant) {
      if (typeof lastAssistant.content === 'string') {
        result = lastAssistant.content
      } else if (Array.isArray(lastAssistant.content)) {
        result =
          lastAssistant.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('') || '(无输出)'
      }
    }

    ctx.agentRegistry.complete(runId, result)
    logger.success(`${tag} 完成 ✓ (${result.length} 字符)`)
    return result
  } catch (err: any) {
    const isAbort = err.name === 'AbortError' || ac.signal.aborted
    const errorMsg = isAbort
      ? `执行超时 (${timeout / 1000}s)`
      : err.message || String(err)
    ctx.agentRegistry.fail(runId, errorMsg)
    logger.error(`${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`)

    if (isAbort) {
      const partial = [...messages]
        .reverse()
        .find((m) => m.role === 'assistant')
      if (partial) {
        const text =
          typeof partial.content === 'string'
            ? partial.content
            : Array.isArray(partial.content)
              ? partial.content
                  .filter((p) => p.type === 'text')
                  .map((p) => p.text)
                  .join('')
              : ''
        if (text) return `[部分结果] ${text}`
      }
    }

    return `[sub-agent 执行失败] ${errorMsg}`
  }
}

export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
) {
  logger.info(`\n┌─ 派发 ${requests.length} 个子 Agent 并行执行 ─┐`)

  const results = await Promise.all(
    requests.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i)
      return { task: req.task, result }
    }),
  )

  logger.info(`└─ 全部完成 (${results.length}/${requests.length}) ─┘\n`)
  return results
}
