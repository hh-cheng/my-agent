import { jsonSchema, type streamText } from 'ai'

import type { MCPClient } from '@/mcp/mcp-client'
import { toolLabel } from '@/logging'

export interface ToolDefinition {
  //* 给 LLM 看的元信息
  name: string
  description: string // 给 LLM 看的描述
  parameters: Parameters<typeof jsonSchema>[0] // JSON Schema 定义的参数
  execute: (input: any) => Promise<unknown> // 执行工具的函数

  //* 给 Agent Loop 决策用的元信息
  isReadOnly?: boolean // 是否只读
  maxResultChars?: number // 结果最大长度
  isConcurrencySafe?: boolean // 是否并发安全

  //* 延迟加载
  shouldDefer?: boolean // 是否延迟加载
  searchHint?: string // 搜索提示词，帮助 ToolSearch 匹配
}

const DEFAULT_MAX_RESULT_CHARS = 3000
export type StreamTextTools = NonNullable<
  Parameters<typeof streamText>[0]['tools']
>

function truncate(text: string, maxChars = DEFAULT_MAX_RESULT_CHARS) {
  if (text.length <= maxChars) return text

  const headSize = Math.floor(maxChars * 0.6)
  const tailSize = maxChars - headSize
  const head = text.slice(0, headSize)
  const tail = text.slice(-tailSize)
  const dropped = text.length - headSize - tailSize

  return `${head}\n\n...\n\n${tail} (截断 ${dropped} 字符)`
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false // 当前是否有独占锁的持有者
  private concurrentCount = 0 // 当前共享锁持有数
  private waitQueue: Array<(ipt: unknown) => void> = [] // 阻塞等待中的 resolve 函数

  private mcpClients: Array<MCPClient> = []

  private discoveredTools = new Set<string>()

  // 获取共享锁：只要没有人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent() {
    while (this.exclusiveLock) {
      await new Promise((r) => this.waitQueue.push(r))
    }
    this.concurrentCount++
  }

  private releaseConcurrent() {
    this.concurrentCount--
    if (this.concurrentCount === 0) this.drainQueue()
  }

  // 获取独占锁：必须等所有共享锁释放，且没人持独占
  private async acquireExclusive() {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise((r) => this.waitQueue.push(r))
    }
    this.exclusiveLock = true
  }

  private releaseExclusive() {
    this.exclusiveLock = false
    this.drainQueue()
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue() {
    const waiting = this.waitQueue.splice(0)
    for (const resolve of waiting) resolve(void 0)
  }

  register(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  unregister(name: string) {
    this.discoveredTools.delete(name)
    return this.tools.delete(name)
  }

  get(name: string) {
    return this.tools.get(name)
  }

  getAll() {
    return Array.from(this.tools.values())
  }

  toAISDKFormat(): StreamTextTools {
    const result: StreamTextTools = {}

    for (const tool of this.getActiveTools()) {
      const name = tool.name
      const registry = this
      const executeFn = tool.execute
      const maxChars = tool.maxResultChars
      const isConcurrentSafe = tool.isConcurrencySafe ?? false

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
        execute: async (ipt: any) => {
          // 在真正执行前先按 isConcurrentSafe 获取锁
          if (isConcurrentSafe) {
            await registry.acquireConcurrent()
            console.log(`${toolLabel('并发')} ${name} 获取共享锁`)
          } else {
            await registry.acquireExclusive()
            console.log(`${toolLabel('独占')} ${name} 获取独占锁`)
          }

          try {
            const raw = await executeFn(ipt)
            const text =
              typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
            return truncate(text, maxChars)
          } finally {
            // 不管成功还是抛异常都要释放锁
            if (isConcurrentSafe) {
              registry.releaseConcurrent()
            } else {
              registry.releaseExclusive()
            }
          }
        },
      }
    }

    return result
  }

  //* mcp 相关
  async registerMCPServer(
    serverName: string,
    client: MCPClient,
  ): Promise<string[]> {
    await client.connect()
    this.mcpClients.push(client)

    const tools = await client.listTools()
    const registered: string[] = []

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`
      if (this.tools.has(prefixedName)) continue

      const toolClient = client
      const originalName = tool.name

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (ipt) => {
          return toolClient.callTool(originalName, ipt)
        },
      })

      registered.push(prefixedName)
    }

    return registered
  }

  async closeAllMCP() {
    for (const client of this.mcpClients) await client.close()
    this.mcpClients = []
  }

  //* 工具搜索相关
  searchTools(query: string) {
    const q = query.trim()
    const results: ToolDefinition[] = []

    const names = q.includes(',')
      ? q
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [q]

    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool && tool.name !== 'tool_search') {
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    if (results.length === 0) {
      const normalized = q.toLowerCase()
      for (const tool of this.tools.values()) {
        if (tool.name === 'tool_search') continue
        const haystack =
          `${tool.name} ${tool.description} ${tool.searchHint ?? ''}`.toLowerCase()
        if (!haystack.includes(normalized)) continue
        results.push(tool)
        this.discoveredTools.add(tool.name)
      }
    }

    return results
  }

  getActiveTools() {
    return this.getAll().filter((tool) => {
      return !(tool.shouldDefer && !this.discoveredTools.has(tool.name))
    })
  }

  getDeferredToolSummary() {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name)
    })

    if (deferred.length === 0) return ''

    const lines = deferred.map((tool) => {
      const hint = tool.searchHint ? ` - ${tool.searchHint}` : ''
      return ` - ${tool.name}${hint}`
    })

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`
  }

  countTokenEstimate() {
    let active = 0
    let deferred = 0

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        parameters: tool.parameters,
        description: tool.description,
      }).length
      const tokens = Math.ceil(schemaSize / 4)

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens
      } else {
        active += tokens
      }
    }

    return { active, deferred, total: active + deferred }
  }
}
