// 只重试临时性错误，避免把明确的 4xx 请求问题反复提交。
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message || ''
  const statusMatch = message.match(/(\d{3})/)
  if (statusMatch) {
    const status = parseInt(statusMatch[1])
    if ([429, 529, 408].includes(status)) return true
    if (status >= 500 && status < 600) return true
    if (status >= 400 && status < 500) return false
  }
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true
  if (message.includes('fetch failed') || message.includes('network'))
    return true
  if (message.includes('No output generated')) return true
  return false
}

// 指数退避加少量抖动，降低多个请求同时重试造成的尖峰。
export function calculateDelay(
  attempt: number,
  baseMs = 500,
  maxMs = 30_000,
): number {
  const exponential = baseMs * Math.pow(2, attempt - 1)
  const capped = Math.min(exponential, maxMs)
  const jitter = capped * 0.25
  return Math.max(0, Math.round(capped + (Math.random() * 2 - 1) * jitter))
}

// 用 Promise 包装 setTimeout，方便在 async 重试流程里暂停。
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
