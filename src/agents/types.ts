export interface SubAgentConfig {
  maxSpawnDepth: number // 最大嵌套深度，默认 1
  maxConcurrent: number // 最大并发子 Agent 数，默认 3
  defaultTimeout: number // 默认执行超时 ms，默认 60_000
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrent: 3,
  defaultTimeout: 60_000,
}

export interface SpawnRequest {
  task: string // 子 agent 的任务描述
  tools?: string[] // 允许使用的工具名 (不传则集成父 agent 的工具)
  timeout?: number // 执行超时 ms
}

export interface SubAgentRun {
  id: string
  task: string // 任务描述
  status: 'running' | 'completed' | 'error' | 'timeout'
  depth: number // 当前嵌套深度
  startedAt: string
  finishedAt?: string
  result?: string
  error?: string
}
