import { logger } from '@/logging'

import type { CommandHandler } from './index.js'
import type { SubAgentRegistry } from '../agents/registry.js'

export function createAgentCommands(
  agentRegistry: SubAgentRegistry,
): CommandHandler[] {
  const handler: CommandHandler = (cmd) => {
    if (!cmd.startsWith('/agents')) return false

    const runs = agentRegistry.getAllRuns()
    if (runs.length === 0) {
      logger.warn('暂无子 Agent 记录')
    } else {
      const active = runs.filter((r) => r.status === 'running')
      const completed = runs.filter((r) => r.status === 'completed')
      const failed = runs.filter((r) => r.status === 'error')

      logger.info(`子 Agent 记录 (${runs.length}):`)
      for (const r of runs) {
        const icon =
          r.status === 'running' ? '⟳' : r.status === 'completed' ? '✓' : '✗'
        const detail =
          r.status === 'completed'
            ? `${r.result?.slice(0, 60)}...`
            : r.status === 'error'
              ? r.error
              : '执行中...'
        logger.raw(
          `    ${icon} ${r.id} (depth=${r.depth}) — ${r.task.slice(0, 40)}`,
        )
        logger.raw(`      ${detail}`)
      }

      const config = agentRegistry.getConfig()
      logger.info(
        `\n活跃: ${active.length}/${config.maxConcurrent} | 完成: ${completed.length} | 失败: ${failed.length}`,
      )
      logger.raw(
        `最大深度: ${config.maxSpawnDepth} | 最大并发: ${config.maxConcurrent}`,
      )
    }
    return true
  }

  return [handler]
}
