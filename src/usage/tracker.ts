import { dirname } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'

export interface ModelPricing {
  input: number // $/1M tokens (cache miss)
  output: number
  cacheWrite: number
  cacheRead: number
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  'claude-sonnet-4-7': {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  'claude-haiku-4-5': {
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
  'gpt-5': { input: 5.0, output: 15.0, cacheWrite: 5.0, cacheRead: 1.25 },
  'deepseek-v3-2': {
    input: 0.27,
    output: 1.1,
    cacheWrite: 0.27,
    cacheRead: 0.027,
  },
  'qwen3-6-plus': { input: 0.4, output: 1.2, cacheWrite: 0.4, cacheRead: 0.04 },
  'mock-model': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
}

export interface StepUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface StepRecord extends StepUsage {
  ts: number
  model: string
  cost: number
}

export function computeCost(model: string, usage: StepUsage): number {
  const p = PRICE_TABLE[model] || PRICE_TABLE['mock-model']
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  )
}

/**
 * 把 AI SDK 返回的 usage 对象规范化成四类 token。
 *
 * AI SDK v5 把 cache read 标准化到顶层 `cachedInputTokens`（OpenAI、DashScope 都映射到这里）。
 * cache write 没有 AI SDK 标准字段，Anthropic provider 元数据用 `cacheCreationInputTokens`。
 * 这里把两个来源都兜一遍，以后接新 provider 就在对应位置补一行。
 */
export function normalizeUsage(usage: any): StepUsage {
  if (!usage)
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }

  const cacheRead =
    usage.cachedInputTokens ?? // AI SDK 标准字段
    usage.providerMetadata?.openai?.cachedTokens ?? // OpenAI 原生
    0

  const cacheWrite =
    usage.cacheCreationInputTokens ?? // Anthropic SDK 直接挂顶层
    usage.providerMetadata?.anthropic?.cacheCreationInputTokens ?? // AI SDK 走 provider 元数据
    0

  // OpenAI 把 cached tokens 含在 inputTokens 里 → 减出来；Anthropic 单列 → 不用减
  let inputTokens = usage.inputTokens ?? 0
  if (cacheRead && inputTokens >= cacheRead) inputTokens -= cacheRead

  return {
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: Math.max(0, inputTokens),
    outputTokens: usage.outputTokens ?? 0,
  }
}

export class UsageTracker {
  private steps: StepRecord[] = []
  private logPath?: string

  constructor(logPath?: string) {
    this.logPath = logPath
    if (logPath) mkdirSync(dirname(logPath), { recursive: true })
  }

  record(model: string, usage: StepUsage): StepRecord {
    const cost = computeCost(model, usage)
    const record: StepRecord = { ts: Date.now(), model, cost, ...usage }
    this.steps.push(record)

    if (this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n')
    }
    return record
  }

  totals() {
    const t = this.steps.reduce(
      (a, s) => ({
        inputTokens: a.inputTokens + s.inputTokens,
        outputTokens: a.outputTokens + s.outputTokens,
        cacheReadTokens: a.cacheReadTokens + s.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens + s.cacheWriteTokens,
        cost: a.cost + s.cost,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      },
    )
    const totalInputLike =
      t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
    const hitRate = totalInputLike > 0 ? t.cacheReadTokens / totalInputLike : 0
    // 没有 cache 时的"假想成本"：把所有 input-like token 当成 miss 全付
    const baselineCost = (() => {
      let c = 0
      for (const s of this.steps) {
        const p = PRICE_TABLE[s.model] || PRICE_TABLE['mock-model']
        const inputLike = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
        c += (inputLike * p.input) / 1_000_000
        c += (s.outputTokens * p.output) / 1_000_000
      }
      return c
    })()
    return {
      ...t,
      hitRate,
      baselineCost,
      savedCost: baselineCost - t.cost,
      steps: this.steps.length,
    }
  }

  recent(n: number): StepRecord[] {
    return this.steps.slice(-n)
  }
}
