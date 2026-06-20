import 'dotenv/config'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'

const REQUEST_TIMEOUT_MS = 15_000
const STDERR_LIMIT = 8_000

function appendLimited(buffer: string, chunk: Buffer | string) {
  const next = buffer + chunk.toString()
  return next.length > STDERR_LIMIT ? next.slice(-STDERR_LIMIT) : next
}

function hasTextContent(result: unknown): result is CallToolResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'content' in result &&
    Array.isArray(result.content)
  )
}

function textContent(result: unknown) {
  if (!hasTextContent(result)) return JSON.stringify(result, null, 2)

  const texts = result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)

  return texts.join('\n') || '(无文本返回)'
}

export async function runGithubMCPDemo() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN
  if (!githubToken) {
    throw new Error('缺少 GITHUB_PERSONAL_ACCESS_TOKEN')
  }

  const transport = new StdioClientTransport({
    command: 'bunx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      ...getDefaultEnvironment(),
      GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
    },
    stderr: 'pipe',
  })

  let stderrBuffer = ''
  transport.stderr?.on('data', (chunk) => {
    stderrBuffer = appendLimited(stderrBuffer, chunk)
  })

  const client = new Client(
    { name: 'super-agent-prod-demo', version: '0.1.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })

    const { tools } = await client.listTools(
      {},
      { timeout: REQUEST_TIMEOUT_MS },
    )
    console.log(`GitHub MCP tools: ${tools.length}`)
    for (const tool of tools.slice(0, 8)) {
      console.log(`- ${tool.name}: ${tool.description ?? '(无描述)'}`)
    }

    const result = await client.callTool(
      {
        name: 'search_repositories',
        arguments: { query: 'modelcontextprotocol typescript sdk' },
      },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    )

    console.log('\nsearch_repositories result:')
    console.log(textContent(result).slice(0, 2_000))
  } catch (err) {
    const detail = stderrBuffer.trim()
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${message}${detail ? `\nMCP stderr:\n${detail}` : ''}`)
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  runGithubMCPDemo().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
