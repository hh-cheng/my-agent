import { $ } from 'bun'
import { extname, join, resolve, sep } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

import { MOCK_PAGES } from '@/mock/mock-pages'
import type { ToolDefinition } from './tool-registry'

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取指定路径的文件内容',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 500, // 生产环境通常是 50000+
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，如 "/data/example.txt"' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute: async ({ path }: { path: string }) => {
    const absolutePath = resolve(path)
    const file = Bun.file(absolutePath)

    if (!(await file.exists())) {
      return `文件不存在: ${absolutePath}`
    }

    try {
      return await file.text()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `读取文件失败: ${absolutePath}\n${message}`
    }
  },
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '写入内容到指定文件',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'content'],
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
  },
  isConcurrencySafe: false, // 写操作不能并行
  isReadOnly: false,
  execute: async ({ path, content }: { path: string; content: string }) => {
    const absolutePath = resolve(path)

    try {
      await Bun.write(absolutePath, content)
      return `文件写入成功: ${absolutePath} (共 ${content.length} 字符)`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `文件写入失败: ${absolutePath}\n${message}`
    }
  },
}

export const listDirectoryTool: ToolDefinition = {
  name: 'list_directory',
  description: '列出指定目录下的文件和子目录',
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，如 "/data"' },
    },
    required: [],
    additionalProperties: false,
  },
  execute: async ({ path = '' }: { path?: string }) => {
    const absolutePath = resolve(path || '.')

    return readdirSync(absolutePath)
      .map((name) => {
        const stat = statSync(join(absolutePath, name))
        return `${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${name}`
      })
      .join('\n')
  },
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    '精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分',
  isReadOnly: false,
  isConcurrencySafe: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: {
        type: 'string',
        description: '要被替换的原始文本（必须精确匹配）',
      },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  execute: async (params: {
    path: string
    old_string: string
    new_string: string
  }) => {
    const { path, old_string, new_string } = params
    const absolutePath = resolve(path)
    if (!existsSync(absolutePath)) return `文件不存在: ${absolutePath}`

    const content = await Bun.file(absolutePath).text()
    const count = content.split(old_string).length - 1

    if (count === 0) {
      return '未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）'
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`
    }

    const updated = content.replace(old_string, new_string)
    await Bun.write(absolutePath, updated)
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`
  },
}

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  isConcurrencySafe: true,
  isReadOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式，如 "**/*.ts"、"src/*.json"',
      },
      path: { type: 'string', description: '搜索起始目录，默认当前目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  execute: async ({
    pattern,
    path = '.',
  }: {
    pattern: string
    path: string
  }) => {
    const absolutePath = resolve(path)

    try {
      if (!existsSync(absolutePath)) {
        return `搜索路径不存在: ${absolutePath}`
      }
      if (!statSync(absolutePath).isDirectory()) {
        return `搜索路径不是目录: ${absolutePath}`
      }

      const glob = new Bun.Glob(pattern)
      const matches = []

      for await (const match of glob.scan({
        cwd: absolutePath,
        dot: true,
        onlyFiles: false,
      })) {
        matches.push(match)
      }

      matches.sort((a, b) => a.localeCompare(b))

      if (matches.length === 0) {
        return `未找到匹配文件: ${pattern} (${absolutePath})`
      }

      const limit = 200
      const shown = matches.slice(0, limit)
      const suffix =
        matches.length > limit ? `\n... 还有 ${matches.length - limit} 项` : ''

      return `匹配结果: ${pattern} (${absolutePath})\n${shown.join('\n')}${suffix}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `glob 搜索失败: ${pattern} (${absolutePath})\n${message}`
    }
  },
}

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: '在文件中搜索匹配指定模式的内容。返回匹配的行号和内容',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultChars: 3000,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式（正则表达式）' },
      path: {
        type: 'string',
        description: '搜索路径（文件或目录），默认当前目录',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  execute: async ({
    pattern,
    path = '.',
  }: {
    pattern: string
    path?: string
  }) => {
    const absolutePath = resolve(path)
    const ignoredDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '.next',
      'coverage',
      'tmp',
      'temp',
    ])

    try {
      if (!existsSync(absolutePath)) {
        return `搜索路径不存在: ${absolutePath}`
      }

      const regex = new RegExp(pattern)
      const files: string[] = []
      const stat = statSync(absolutePath)

      if (stat.isFile()) {
        files.push(absolutePath)
      } else if (stat.isDirectory()) {
        const glob = new Bun.Glob('**/*')
        for await (const file of glob.scan({
          cwd: absolutePath,
          absolute: true,
          dot: true,
          onlyFiles: true,
        })) {
          const parts = file.split(/[\\/]/)
          if (parts.some((part) => ignoredDirs.has(part))) continue
          files.push(file)
        }
      } else {
        return `搜索路径不是文件或目录: ${absolutePath}`
      }

      files.sort((a, b) => a.localeCompare(b))

      const maxMatches = 100
      const matches: string[] = []
      let totalMatches = 0

      for (const file of files) {
        let content: string
        try {
          content = await Bun.file(file).text()
        } catch {
          continue
        }

        const lines = content.split(/\r?\n/)
        for (const [index, line] of lines.entries()) {
          regex.lastIndex = 0
          if (!regex.test(line)) continue

          totalMatches++
          if (matches.length < maxMatches) {
            matches.push(`${file}:${index + 1}: ${line}`)
          }
        }
      }

      if (totalMatches === 0) {
        return `未找到匹配内容: ${pattern} (${absolutePath})`
      }

      const suffix =
        totalMatches > maxMatches
          ? `\n... 还有 ${totalMatches - maxMatches} 处匹配`
          : ''

      return `搜索结果: ${pattern} (${absolutePath})\n${matches.join('\n')}${suffix}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `grep 搜索失败: ${pattern} (${absolutePath})\n${message}`
    }
  },
}

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    '执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作',
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultChars: 3000,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  execute: async ({ command }: { command: string }) => {
    try {
      const result = await $`sh -c ${command}`.quiet().nothrow()
      const stdout = result.stdout.toString()
      const stderr = result.stderr.toString()
      const sections = [`exitCode: ${result.exitCode}`]

      if (stdout) sections.push(`stdout:\n${stdout.trimEnd()}`)
      if (stderr) sections.push(`stderr:\n${stderr.trimEnd()}`)

      return sections.join('\n\n')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `命令执行失败: ${command}\n${message}`
    }
  },
}

export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 1500,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '完整 URL，必须以 http:// 或 https:// 开头',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  execute: async ({ url }: { url: string }) => {
    let parsedUrl: URL

    try {
      parsedUrl = new URL(url)
    } catch {
      return `URL 无效: ${url}`
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return `URL 协议不支持: ${parsedUrl.protocol}。只支持 http:// 或 https://`
    }

    for (const key of Object.keys(MOCK_PAGES)) {
      if (url.startsWith(key)) return MOCK_PAGES[key]
    }

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'Mozilla/5.0 SuperAgent' },
      })
      if (!res.ok) return `请求失败：HTTP ${res.status}`
      const html = await res.text()
      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || '页面无文本内容'
      )
    } catch (err) {
      return `抓取 URL 失败: ${url}\n${err instanceof Error ? err.message : String(err)}`
    }
  },
}

let previewServer: ReturnType<typeof Bun.serve> | null = null
let previewPort: number | null = null

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.tsx': 'application/javascript; charset=utf-8', // 让浏览器把 .tsx 当 JS 加载
  '.ts': 'application/javascript; charset=utf-8',
}

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  isConcurrencySafe: false,
  isReadOnly: false,
  parameters: {
    type: 'object',
    properties: { port: { type: 'number' } },
    required: [],
    additionalProperties: false,
  },
  execute: async ({ port = 8000 }: { port?: number }) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return `端口无效: ${port}。请输入 1-65535 之间的整数`
    }

    if (previewServer) {
      return `预览服务器已在端口 ${previewPort} 运行 → http://127.0.0.1:${previewPort}`
    }

    const root = resolve('app')
    if (!existsSync(root)) return 'app/ 目录不存在'

    try {
      previewServer = Bun.serve({
        port,
        hostname: '127.0.0.1',
        async fetch(req) {
          const requestUrl = new URL(req.url)
          const urlPath = requestUrl.pathname.replace(/\/$/, '/index.html')
          let filePath: string

          try {
            filePath = resolve(
              root,
              `.${decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath)}`,
            )
          } catch {
            return new Response('Bad Request', { status: 400 })
          }

          if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
            return new Response('Forbidden', { status: 403 })
          }

          const file = Bun.file(filePath)
          if (!(await file.exists())) {
            return new Response('404 Not Found', {
              status: 404,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            })
          }

          return new Response(await file.arrayBuffer(), {
            headers: {
              'Content-Type':
                MIME[extname(filePath).toLowerCase() as keyof typeof MIME] ||
                'application/octet-stream',
              'Cache-Control': 'no-cache',
            },
          })
        },
      })
      previewPort = port
      return `✓ 预览服务器已启动 → http://127.0.0.1:${port}`
    } catch (error) {
      previewServer = null
      previewPort = null
      const message = error instanceof Error ? error.message : String(error)
      return `预览服务器启动失败: ${message}`
    }
  },
}

export const allTools: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  startPreviewTool,
]
