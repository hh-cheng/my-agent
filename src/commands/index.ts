import type { ModelMessage } from 'ai'

import type { BudgetState } from '@/agent/loop'
import type { MemoryStore } from '@/memory/store'
import type { UsageTracker } from '@/usage/tracker'
import type { SessionStore } from '@/session/store'
import type { ToolRegistry } from '@/tools/tool-registry'
import type { PromptBuilder, PromptContext } from '@/context/prompt-builder'

export interface CommandContext {
  model: any
  modelName: string
  modelId: string
  budget: BudgetState
  tracker: UsageTracker
  registry: ToolRegistry
  builder: PromptBuilder
  messages: ModelMessage[]
  memoryStore?: MemoryStore
  sessionStore: SessionStore
  timestamps: Map<number, number>
  [key: string]: any

  ask(): void
  makePromptCtx(): PromptContext
}

export type CommandHandler = (
  cmd: string,
  ctx: CommandContext,
) => boolean | 'async'

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx)
      if (result) return result
    }
    return false
  }
}
