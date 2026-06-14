import { join, resolve } from 'node:path'
import { readdirSync, statSync } from 'node:fs'

import type { ToolDefinition } from './tool-registry'

export const weatherTool: ToolDefinition = {
  name: 'get_weather',
  description: '查询指定城市的天气信息',
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名称，如“北京”或“上海”' },
    },
    required: ['city'],
    additionalProperties: false,
  },
  execute: async ({ city }: { city: string }) => {
    const mockWeather = {
      北京: '晴，15-25°C，东南风 2 级',
      上海: '多云，18-22°C，西南风 3 级',
      深圳: '阵雨，22-28°C，南风 2 级',
    }
    return mockWeather[city as keyof typeof mockWeather] || '暂无数据'
  },
}

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  isReadOnly: true,
  isConcurrencySafe: true,
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 生产环境不要用 eval，这里纯粹为了演示
      const result = new Function(`return ${expression}`)()
      return `${expression} = ${result}`
    } catch {
      return `无法计算: ${expression}`
    }
  },
}

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

export const allTools: ToolDefinition[] = [
  weatherTool,
  calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
]
