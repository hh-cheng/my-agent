import TurndownService from 'turndown'

import type { ToolDefinition } from './tool-registry'

type QueryParams = {
  query: string
  max_results?: number
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'iframe'])

function htmlToMarkdown(html: string) {
  return turndown.turndown(html)
}

//* Tavily (自动挡)
export const tavilySearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 3000,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
  },
  execute: async ({ query, max_results = 5 }: QueryParams) => {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) return '[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置'

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results,
        api_key: apiKey,
        include_answer: true,
      }),
    })

    if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`

    const data = await res.json()
    const lines: string[] = []

    for (const r of data.results || []) {
      lines.push(`### ${r.title}`)
      lines.push(r.url)
      lines.push(r.content || r.snippet || '')
      lines.push('')
    }

    return lines.join('\n') || '没有找到相关信息'
  },
}

//* Serper (手动挡)
export const serperSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      max_results: { type: 'number', description: '返回结果数量，默认 5' },
    },
    required: ['query'],
  },
  execute: async ({ query, max_results = 5 }: QueryParams) => {
    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置'

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        X_API_KEY: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: max_results }),
    })

    if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`

    const data = await res.json()
    const lines: string[] = []

    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph
      lines.push(`## ${kg.title}`)
      if (kg.description) lines.push(kg.description)
      lines.push('')
    }

    for (const r of (data.organic || []).slice(0, max_results)) {
      lines.push(`### ${r.title}`)
      lines.push(r.link)
      lines.push(r.snippet || '')
      lines.push('')
    }

    return lines.join('\n') || '没有找到相关结果'
  },
}

//* 抓取具体网页内容
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式',
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
    },
    required: ['url'],
  },
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible;SuperAgent/1.0)' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return `请求失败: HTTP ${res.status}`
      const html = await res.text()
      return htmlToMarkdown(html)
    } catch (err) {
      return `抓取失败: ${url}\n${err instanceof Error ? err.message : String(err)}`
    }
  },
}

export function pickSearchTool() {
  if (process.env.TAVILY_API_KEY) return tavilySearchTool
  if (process.env.SERPER_API_KEY) return serperSearchTool
  return tavilySearchTool
}
