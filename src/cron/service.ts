import { CronStore } from './store'
import { parseSchedule, getNextCronTime } from './parser'
import type { CronJobConfig, CronJobState, RunLog, JobPayload } from './types'
import { logger } from '@/logging'

const QUOTES = [
  '"知之为知之，不知为不知，是知也。" —— 孔子',
  '"学而不思则罔，思而不学则殆。" —— 孔子',
  '"千里之行，始于足下。" —— 老子',
  '"天行健，君子以自强不息。" —— 《周易》',
  '"不积跬步，无以至千里。" —— 荀子',
  '"Stay hungry, stay foolish." —— Steve Jobs',
  '"The best way to predict the future is to invent it." —— Alan Kay',
  '"Talk is cheap. Show me the code." —— Linus Torvalds',
  '"Simplicity is the ultimate sophistication." —— Leonardo da Vinci',
  '"First, solve the problem. Then, write the code." —— John Johnson',
]

export interface CronExecutor {
  notify?: (message: string) => void
  runAgentPrompt: (prompt: string, timeout?: number) => Promise<string>
}

export class CronService {
  private jobs = new Map<string, CronJobState>()
  private store: CronStore
  private executor?: CronExecutor
  private running = false

  constructor(baseDir = '.') {
    this.store = new CronStore(baseDir)
    this.store.init()
  }

  setExecutor(executor: CronExecutor) {
    this.executor = executor
  }

  load() {
    const configs = this.store.loadJobs()
    for (const config of configs) {
      if (config.enabled) {
        this.jobs.set(config.id, {
          config,
          timerId: null,
          running: false,
          consecutiveFailures: 0,
        })
      }
    }
  }

  start() {
    if (this.running) return
    this.running = true
    for (const state of this.jobs.values()) {
      if (state.config.enabled) this.scheduleJob(state)
    }
  }

  stop() {
    this.running = false
    for (const state of this.jobs.values()) {
      if (state.timerId) {
        clearTimeout(state.timerId)
        state.timerId = null
      }
    }
  }

  add(config: CronJobConfig) {
    if (this.jobs.has(config.id)) {
      throw new Error(`任务 ${config.id} 已存在`)
    }

    const state: CronJobState = {
      config,
      timerId: null,
      running: false,
      consecutiveFailures: 0,
    }
    this.jobs.set(config.id, state)
    this.persist()
    if (this.running && config.enabled) this.scheduleJob(state)
  }

  remove(id: string) {
    const state = this.jobs.get(id)
    if (!state) return false
    if (state.timerId) clearTimeout(state.timerId)
    this.jobs.delete(id)
    this.persist()
    return true
  }

  enable(id: string) {
    const state = this.jobs.get(id)
    if (!state) return false
    state.config.enabled = true
    state.consecutiveFailures = 0
    this.persist()
    if (this.running) this.scheduleJob(state)
    return true
  }

  disable(id: string) {
    const state = this.jobs.get(id)
    if (!state) return false
    state.config.enabled = false
    if (state.timerId) {
      clearTimeout(state.timerId)
      state.timerId = null
    }
    this.persist()
    return true
  }

  list() {
    return Array.from(this.jobs.values()).map((state) => ({
      config: state.config,
      lastRun: state.lastRun,
      status: state.running
        ? 'running'
        : !state.config.enabled
          ? 'disabled'
          : state.timerId
            ? 'scheduled'
            : 'idle',
    }))
  }

  async runNow(id: string) {
    const state = this.jobs.get(id)
    if (!state) return `任务 ${id} 不存在`
    return this.executeJob(state)
  }

  getRecentLogs(jobId?: string, limit?: number) {
    return this.store.getRecentLogs(jobId, limit)
  }

  private scheduleJob(state: CronJobState) {
    if (state.timerId) {
      clearTimeout(state.timerId)
      state.timerId = null
    }

    try {
      const parsed = parseSchedule(state.config.schedule)
      let delayMs: number

      switch (parsed.type) {
        case 'interval': {
          delayMs = parsed.intervalMs!
          break
        }
        case 'once': {
          const diff = parsed.onceAt!.getTime() - Date.now()
          if (diff <= 0) {
            this.executeJob(state)
            return
          }
          delayMs = diff
          break
        }
        case 'cron': {
          delayMs = getNextCronTime(parsed.cronInstance!)
          break
        }
      }

      state.timerId = setTimeout(async () => {
        await this.executeJob(state)
        if (parsed.type !== 'once' && state.config.enabled && this.running) {
          this.scheduleJob(state)
        } else if (parsed.type === 'once') {
          this.remove(state.config.id)
        }
      }, delayMs)
    } catch (err: any) {
      logger.error(`[cron] ✗ 调度失败 ${state.config.id}: ${err.message}`)
    }
  }

  private async executeJob(state: CronJobState) {
    if (state.running) return '任务执行中'
    state.running = true

    const startedAt = new Date().toISOString()
    let output = ''
    let status: RunLog['status'] = 'success'
    let error: string | undefined

    try {
      const timeout = state.config.timeout || 60_000
      output = await this.runPayload(state.config.payload, timeout)
      state.consecutiveFailures = 0
    } catch (err: any) {
      status = err.message?.includes('timeout') ? 'timeout' : 'error'
      error = err.message
      output = `执行失败 ${err.message}`
      state.consecutiveFailures++

      const maxRetries = state.config.maxRetries ?? 3
      if (state.consecutiveFailures >= maxRetries) {
        state.config.enabled = false
        logger.error(
          `[cron] ✗ ${state.config.id} 连续失败 ${maxRetries} 次，已自动禁用`,
        )
        this.persist()
      }
    } finally {
      state.running = false
    }

    const log: RunLog = {
      error,
      status,
      jobId: state.config.id,
      output: output.slice(0, 1000),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
    state.lastRun = log
    this.store.appendLog(log)

    if (this.executor?.notify) {
      const icon = status === 'success' ? '✓' : '✗'
      this.executor.notify(
        `[cron] ${icon} ${state.config.name}: ${output.slice(0, 200)}`,
      )
    }

    return output
  }

  private async runPayload(payload: JobPayload, timeout: number) {
    if (!this.executor) {
      return '[cron] 为设置执行器，无法执行任务'
    }

    if (payload.type === 'agent') {
      return this.executor.runAgentPrompt(payload.prompt, timeout)
    }

    if (payload.type === 'handler') {
      if (payload.handler === 'random-quote') {
        return QUOTES[Math.floor(Math.random() * QUOTES.length)]
      }

      return `[handler] ${payload.handler} - handler 类型需要通过插件注册`
    }

    return '未知 payload 类型'
  }

  private persist() {
    const configs = Array.from(this.jobs.values())
      .filter((s) => s.config.source === 'runtime')
      .map((s) => s.config)
    const existing = this.store.loadJobs().filter((j) => j.source === 'config')
    this.store.saveJobs([...existing, ...configs])
  }
}
