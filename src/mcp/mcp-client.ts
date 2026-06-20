import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

import type { MCPTool, MCPCallResult } from './mcp-types'

export class MCPClient {
  private requestId = 0
  private rl: Interface | null = null
  private process: ChildProcess | null = null
  // MCP server 的启动错误通常写到 stderr；保留最近输出用于超时诊断。
  private stderrBuffer = ''
  // JSON-RPC 允许并发请求，用 id 把 stdout 返回和调用方的 Promise 对上。
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
    }
  >()

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {}

  private send(method: string, params?: unknown) {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin || this.process.killed) {
        reject(new Error(`MCP process is not running for request: ${method}`))
        return
      }

      const id = this.requestId++
      // 如果 server 没按协议返回，不能让 Agent 一直挂起。
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        const detail = this.stderrBuffer.trim()
        reject(
          new Error(
            `MCP request timeout: ${method}${detail ? `\n${detail}` : ''}`,
          ),
        )
      }, 15_000)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout)
          resolve(v)
        },
        reject: (err) => {
          clearTimeout(timeout)
          reject(err)
        },
      })

      // MCP stdio transport：每行是一条 JSON-RPC 消息。
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      this.process!.stdin!.write(msg + '\n', (err) => {
        if (!err) return

        clearTimeout(timeout)
        this.pending.delete(id)
        reject(err)
      })
    })
  }

  async connect() {
    // 本地 MCP server 作为子进程运行，通过 stdin/stdout 和 Agent 通信。
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    })
    this.process.on('error', (err) => {
      console.error(`[MCP] 进程启动失败: ${err.message}`)
      this.rejectAllPending(err)
    })
    this.process.on('exit', (code, signal) => {
      const detail = this.stderrBuffer.trim()
      const reason =
        code === 0
          ? `MCP process exited${signal ? ` with signal ${signal}` : ''}`
          : `MCP process exited with code ${code}${signal ? ` and signal ${signal}` : ''}`

      this.rejectAllPending(
        new Error(`${reason}${detail ? `\n${detail}` : ''}`),
      )
    })
    this.process.stderr?.on('data', (chunk) => {
      this.stderrBuffer += chunk.toString()
      // 避免长时间运行时 stderr 无限增长，同时保留最近的错误上下文。
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000)
      }
    })

    // stdout 只承载 MCP 协议消息；按行解析每条 JSON-RPC 响应。
    this.rl = createInterface({ input: this.process.stdout! })
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) {
            p.reject(
              new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
            )
          } else {
            p.resolve(msg.result)
          }
        }
      } catch {}
    })

    // MCP 握手：initialize 成功后，再发送 initialized 通知进入可用状态。
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'super-agent', version: '0.5.0' },
    })

    this.process.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    )
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.send('tools/list', {})
    return (result as { tools: MCPTool[] }).tools || []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.send('tools/call', {
      name,
      arguments: args,
    })) as MCPCallResult

    const texts = (result.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)

    return texts.join('\n') || '(无返回内容)'
  }

  async close() {
    if (this.rl) this.rl.close()
    if (this.process) this.process.kill()
  }

  private rejectAllPending(err: Error) {
    const pending = Array.from(this.pending.values())
    this.pending.clear()
    for (const request of pending) request.reject(err)
  }
}
