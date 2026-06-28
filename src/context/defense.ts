import { ModelMessage } from 'ai'

const CONTEXT_WINDOW = 200_000

function outputToText(output: unknown): string {
  if (typeof output === 'string') return output
  if (
    output &&
    typeof output === 'object' &&
    'value' in output &&
    typeof output.value === 'string'
  ) {
    return output.value
  }

  return JSON.stringify(output)
}

function withOutput(part: any, output: string) {
  if (
    part.output &&
    typeof part.output === 'object' &&
    part.output.type === 'text' &&
    'value' in part.output
  ) {
    return {
      ...part,
      output: {
        ...part.output,
        value: output,
      },
    }
  }

  return { ...part, output }
}

export class TokenTracker {
  private lastPreciseCount = 0 // 上次 API 返回的精确值
  private pendingChars = 0 // 新增消息的字符数

  updateFromAPI(promptTokens: number) {
    this.lastPreciseCount = promptTokens
    this.pendingChars = 0
  }

  addMessage(content: string) {
    this.pendingChars += content.length
  }

  get estimatedTokens() {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4)
  }

  get status() {
    const tokens = this.estimatedTokens
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100)

    return { tokens, percent, needsAction: percent >= 75 }
  }
}

//* === 预估消息 tokens ===
export function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length
        } else if ('output' in part) {
          chars += outputToText(part.output).length
        }
      }
    }
  }
  // 4 chars per token, with 1.2x safety factor for Chinese
  return Math.ceil((chars / 4) * 1.2)
}

//* === 工具结果截断 ===

const DEFAULT_TRUNCATION = {
  maxSingleResult: CONTEXT_WINDOW * 0.5 * 2, // 50% 窗口，2 chars/token
  contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4, // 75% 窗口，4 chars/token
} as const

export function truncateToolResults(
  messages: ModelMessage[],
  config = DEFAULT_TRUNCATION,
) {
  let truncated = 0,
    compacted = 0

  // pass 1: 单条截断 —— 超过窗口 50% 的工具结果做 Head / Tail 截断
  let result = messages.map((msg) => {
    if (msg.role !== 'tool') return msg
    const newContent = msg.content.map((part: any) => {
      if (!part.output) return part

      const output = outputToText(part.output)
      if (output.length <= config.maxSingleResult) return part

      truncated++
      const head = output.slice(0, Math.floor(config.maxSingleResult * 0.6))
      const tail = output.slice(-Math.floor(config.maxSingleResult * 0.4))
      return withOutput(
        part,
        `${head}\n\n[truncated: ${output.length} -> ${config.maxSingleResult} chars]\n\n${tail}`,
      )
    })

    return { ...msg, content: newContent }
  })

  // pass 2: 总量预算 —— 如果总字符数还超 75% 则从最老的 tool result 开始清理
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === 'string') return sum + msg.content.length
    if (Array.isArray(msg.content)) {
      return (
        sum +
        msg.content.reduce((s, p) => {
          if ('output' in p && p.output)
            return s + outputToText(p.output).length
          return s + (p.text?.length || 0)
        }, 0)
      )
    }

    return sum
  }, 0)

  if (totalChars > config.contextBudgetChars) {
    for (
      let i = 0;
      i < result.length && totalChars > config.contextBudgetChars;
      i++
    ) {
      const msg = result[i]
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
      const toolName = msg.content[0]?.toolName || 'unknown'
      const oldSize: number = msg.content.reduce((s, p) => {
        return s + (p.output ? outputToText(p.output).length : 0)
      }, 0)

      result[i] = {
        ...msg,
        content: msg.content.map((p) =>
          withOutput(
            p,
            `[compacted: ${toolName} output removed to free context]`,
          ),
        ),
      }

      compacted++
      totalChars -= oldSize
    }
  }

  return { messages: result, truncated, compacted }
}

//* === TTL 清理 ===

const DEFAULT_TTL = {
  softTTLMs: 5 * 60 * 1000, // 5 分钟
  hardTTLMs: 10 * 60 * 1000, // 10 分钟
  keepHeadTail: 1500, // 保留在软 TTL 的字符数
} as const

export interface PruneResult {
  softPruned: number
  hardPruned: number
  messages: ModelMessage[]
}

export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  config = DEFAULT_TTL,
): PruneResult {
  const now = Date.now()
  let softPruned = 0,
    hardPruned = 0

  const result = messages.map((msg, idx) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg

    const ts = timestamps.get(idx)
    if (!ts) return msg

    const age = now - ts

    // 保留错误信息，不清除报错结果
    const outputText = msg.content
      .map((p: any) => {
        return p.output ? outputToText(p.output) : ''
      })
      .join('')
    const isError = /error|失败|不存在|denied|refused|timeout/i.test(outputText)
    if (isError) return msg

    // 硬清除
    if (age > config.hardTTLMs) {
      hardPruned++
      const toolName = (msg.content[0] as any)?.toolName || 'unknown'
      return {
        ...msg,
        content: msg.content.map((part) =>
          withOutput(part, `[tool result expired: ${toolName}]`),
        ),
      }
    }

    // 软清除
    if (age >= config.softTTLMs) {
      const newContent = msg.content.map((part: any) => {
        if (!part.output) return part

        const output = outputToText(part.output)
        if (output.length <= config.keepHeadTail * 2) return part

        softPruned++
        const head = output.slice(0, config.keepHeadTail)
        const tail = output.slice(-config.keepHeadTail)
        const removed = output.length - config.keepHeadTail * 2

        return withOutput(
          part,
          `${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`,
        )
      })
      return {
        ...msg,
        content: newContent,
      }
    }

    return msg
  })

  return { messages: result, softPruned, hardPruned }
}

//* === 防御主入口 ===
export interface DefenseResult {
  messages: ModelMessage[]
  estimatedTokens: number
  truncated: number
  compacted: number
  softPruned: number
  hardPruned: number
}

export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  const trunc = truncateToolResults(messages)
  let result = trunc.messages

  const prune = ttlPrune(result, timestamps)
  result = prune.messages

  const estimatedTokens = estimateMessageTokens(result)

  return {
    messages: result,
    estimatedTokens,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  }
}
