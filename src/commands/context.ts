import type { CommandHandler } from '.'
import { logger } from '@/logging'
import type { ToolRegistry } from '@/tools/tool-registry'
import {
  renderContextView,
  buildContextSnapshot,
  renderUsageView,
} from '@/context/view'

function estimateToolDescriptionChars(registry: ToolRegistry): number {
  return JSON.stringify(
    registry.getActiveTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  ).length
}

export const contextCommands: CommandHandler[] = [
  async (cmd, ctx) => {
    if (cmd !== '/context' && cmd !== 'context') return false

    const systemPrompt = await ctx.builder.build(ctx.makePromptCtx())
    const memorySection = await ctx.memoryStore?.buildPromptSection()
    const memoryChars = memorySection?.length ?? 0
    const snapshot = buildContextSnapshot({
      modelId: ctx.modelId,
      modelName: ctx.modelName,
      windowTokens: ctx.budget.limit,
      systemPromptChars: systemPrompt.length,
      toolDescriptionChars: estimateToolDescriptionChars(ctx.registry),
      memoryChars,
      skillsChars: 0,
      messages: ctx.messages,
    })

    logger.raw(renderContextView(snapshot))
    return true
  },

  (cmd, ctx) => {
    if (cmd !== '/usage' && cmd !== 'usage') return false
    logger.raw(renderUsageView(ctx.tracker))
    return true
  },
]
