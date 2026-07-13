import { type SubAgentRun, type SubAgentConfig, DEFAULT_CONFIG } from './types'

export class SubAgentRegistry {
  private idCounter = 0
  private config: SubAgentConfig
  private runs = new Map<string, SubAgentRun>()

  constructor(config?: Partial<SubAgentConfig>) {
    if (config) {
      this.config = { ...DEFAULT_CONFIG, ...config }
    } else {
      this.config = DEFAULT_CONFIG
    }
  }

  generateId() {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`
  }

  canSpawn(currentDepth: number) {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return {
        ok: false,
        reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}`,
      }
    }

    const activeCount = this.getActiveRuns().length
    if (activeCount >= this.config.maxConcurrent) {
      return {
        ok: false,
        reason: `已达最大并发数 ${this.config.maxConcurrent}，等待现有任务完成`,
      }
    }

    return { ok: true }
  }

  register(run: SubAgentRun) {
    this.runs.set(run.id, run)
  }

  complete(id: string, result: string) {
    const run = this.runs.get(id)
    if (!run) return
    run.status = 'completed'
    run.result = result
    run.finishedAt = new Date().toISOString()
  }

  fail(id: string, error: string) {
    const run = this.runs.get(id)
    if (!run) return
    run.status = 'error'
    run.error = error
    run.finishedAt = new Date().toISOString()
  }

  get(id: string) {
    return this.runs.get(id)
  }

  getActiveRuns() {
    return Array.from(this.runs.values()).filter((r) => r.status === 'running')
  }

  getAllRuns() {
    return Array.from(this.runs.values())
  }

  getConfig() {
    return this.config
  }
}
