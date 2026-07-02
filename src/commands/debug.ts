import { logger } from '@/logging'
import type { CommandHandler } from '.'
import { estimateMessageTokens, applyDefense } from '@/context/defense'

export const debugCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== 'defend') return false

    logger.raw('\n=== 执行三层防线 ===')
    const before = estimateMessageTokens(ctx.messages)
    const def = applyDefense(ctx.messages, ctx.timestamps)

    ctx.messages.splice(0, ctx.messages.length, ...def.messages)

    logger.raw(
      `  [Layer 2] 截断: ${def.truncated} 条, 预算清理: ${def.compacted} 条`,
    )
    logger.raw(
      `  [Layer 3] 软修剪: ${def.softPruned}, 硬清除: ${def.hardPruned}`,
    )
    logger.raw(
      `  [结果] ~${before} → ~${def.estimatedTokens} tokens (节省 ${before - def.estimatedTokens})\n`,
    )

    return true
  },

  (cmd, ctx) => {
    if (cmd !== '/status' && cmd !== 'status' && cmd !== '查看状态')
      return false

    const tokens = estimateMessageTokens(ctx.messages)
    const system = ctx.builder.build(ctx.makePromptCtx())
    const tools = ctx.registry.countTokenEstimate()
    const totals = ctx.tracker.totals()
    const pct = Math.round((ctx.budget.used / ctx.budget.limit) * 100)

    logger.raw(
      [
        '',
        '[状态]',
        `模型：${ctx.modelName} (${ctx.modelId})`,
        `消息数：${ctx.messages.length}`,
        `消息 token 估算：~${tokens}`,
        `System prompt：${system.length} chars`,
        `工具：${ctx.registry.getActiveTools().length} active，deferred ~${tools.deferred} tokens，总计 ~${tools.total} tokens`,
        `预算：${ctx.budget.used}/${ctx.budget.limit} tokens (${pct}%)`,
        `Usage：${totals.steps} 步，$${totals.cost.toFixed(4)}，cache hit ${(totals.hitRate * 100).toFixed(1)}%`,
        '',
      ].join('\n'),
    )

    return true
  },
]
