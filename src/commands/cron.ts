import { logger } from '@/logging'

import type { CommandHandler } from './index.js'
import type { CronService } from '../cron/service.js'

export function createCronCommands(cronService: CronService): CommandHandler[] {
  const handler: CommandHandler = (cmd) => {
    if (!cmd.startsWith('/cron')) return false

    const sub = cmd.slice(5).trim()

    if (!sub || sub === 'list') {
      const jobs = cronService.list()
      if (jobs.length === 0) {
        logger.warn('暂无定时任务')
      } else {
        logger.info(`定时任务 (${jobs.length}):`)
        for (const j of jobs) {
          const icon =
            j.status === 'running'
              ? '⟳'
              : j.status === 'scheduled'
                ? '◉'
                : j.status === 'disabled'
                  ? '○'
                  : '·'
          logger.raw(
            `${icon} ${j.config.id} — ${j.config.name} [${j.config.schedule}] (${j.status})`,
          )
        }
      }
      return true
    }

    if (sub === 'logs') {
      const logs = cronService.getRecentLogs(undefined, 10)
      if (logs.length === 0) {
        logger.warn('暂无执行记录')
      } else {
        logger.info('最近执行记录:')
        for (const l of logs) {
          const icon = l.status === 'success' ? '✓' : '✗'
          logger.raw(
            `${icon} ${l.jobId} @ ${l.startedAt} — ${l.output?.slice(0, 80) || l.error || ''}`,
          )
        }
      }
      return true
    }

    logger.warn('用法: /cron [list|logs]')
    return true
  }

  return [handler]
}
