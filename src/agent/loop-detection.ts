import { createHash } from 'node:crypto'

export interface ToolCallRecord {
  toolName: string
  argsHash: string
  resultHash?: string
  timestamp: number
}

export type DetectorKind =
  | 'generic_repeat'
  | 'ping_pong'
  | 'global_circuit_breaker'

export type DetectionResult =
  | { stuck: false }
  | {
      stuck: true
      level: 'warning' | 'critical'
      detector: DetectorKind
      count: number
      message: string
    }

const HISTORY_SIZE = 30 // 滑动窗口大小
const WARNING_THRESHOLD = 5 // 警告阈值 ( 生产环境通常是 10 )
const CRITICAL_THRESHOLD = 8 // 严重阈值 ( 生产环境通常是 20 )
const BREAKER_THRESHOLD = 10 // 熔断阈值 ( 生产环境通常是 30 )

// 稳定序列化对象，避免相同参数因 key 顺序不同得到不同 hash。
function stableStringify(ipt: unknown): string {
  if (ipt === null || typeof ipt !== 'object') return JSON.stringify(ipt)
  if (Array.isArray(ipt)) return `[${ipt.map(stableStringify).join(',')}]`
  const keys = Object.keys(ipt as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${key}:${stableStringify((ipt as Record<string, unknown>)[key])}`).join(',')}}`
}

function hash(ipt: string) {
  return createHash('sha256').update(ipt).digest('hex').slice(0, 16)
}

export function hashToolCall(toolName: string, params: unknown) {
  return `${toolName}:${hash(stableStringify(params))}`
}

export function hashResult(result: unknown) {
  return hash(stableStringify(result))
}

//* 滑动窗口：只保留最近的调用，避免历史数据无限增长。
const history: ToolCallRecord[] = []

export function recordCall(toolName: string, params: unknown) {
  history.push({
    toolName,
    timestamp: Date.now(),
    argsHash: hash(stableStringify(params)),
  })

  if (history.length > HISTORY_SIZE) history.shift()
}

// 工具结果会在 tool-call 之后到达，因此回填到最近一次匹配的调用记录。
export function recordResult(
  toolName: string,
  params: unknown,
  result: unknown,
) {
  const argsHash = hashToolCall(toolName, params)
  const resultHash = hashResult(result)
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].toolName === toolName && history[i].argsHash === argsHash) {
      history[i].resultHash = resultHash
      return
    }
  }
}

export function resetHistory() {
  history.length = 0
}

//* 检测器
// 统计同一工具、同一参数连续返回相同结果的次数。
function getNoProgressStreak(toolName: string, argsHash: string) {
  let streak = 0
  let lastResultHash = ''
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue
    if (!r.resultHash) continue
    if (!lastResultHash) {
      lastResultHash = r.resultHash
      streak = 1
      continue
    }
    if (r.resultHash !== lastResultHash) break
    streak++
  }
  return streak
}

// 检测 A/B/A/B 这类交替调用，通常说明模型卡在两个操作之间。
function getPingPongCount(currentHash: string): number {
  if (history.length < 3) return 0
  const last = history[history.length - 1]
  let otherHash = ''

  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash
      break
    }
  }

  if (!otherHash) return 0

  let count = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash
    if (history[i].argsHash !== expected) break
    count++
  }
  if (currentHash === otherHash && count >= 2) return count + 1
  return 0
}

//* 主检测函数：先看无进展熔断，再看乒乓，最后看普通重复调用。
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params)
  const noProgress = getNoProgressStreak(toolName, argsHash)

  //* 无进展检测
  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    }
  }

  //* 乒乓检测
  const pingPong = getPingPongCount(argsHash)
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[熔断] 检测到乒乓循环 (${pingPong} 次交替)，强制停止`,
    }
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[警告] 检测到乒乓循环 (${pingPong} 次交替)，建议换个思路`,
    }
  }

  //* 重复参数调用检测
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === argsHash,
  ).length
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    }
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，建议换个思路`,
    }
  }

  return { stuck: false }
}
