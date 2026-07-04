import { MemoryStore } from '@/memory/store'
import { ToolDefinition } from './tool-registry'

export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description: '管理夸回话记忆。action: save | list | search | read | delete',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'list', 'search', 'read', 'delete'],
        },
        name: {
          type: 'string',
          description: '记忆名称 (save 时必填)',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
        },
        content: { type: 'string', description: '记忆内容 (save 时必填)' },
        query: { type: 'string', description: '搜索关键词 (query 时必填)' },
        filename: {
          type: 'string',
          description: '文件名 (read/delete 时必填)',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      const { action, name, type, content, description, filename } = args

      switch (args.action) {
        case 'save': {
          if (!name || !type || !content) {
            return '保存失败: 需要 name, type, content 参数'
          }
          const filename = memoryStore.save({
            name,
            type,
            content,
            description: description || name,
          })
          return `已保存到记忆: ${filename}`
        }
        case 'list': {
          const entries = memoryStore.list()
          if (entries.length === 0) return '当前没有存储任何记忆。'
          return (
            `记忆列表 (共 ${entries.length} 条记忆):\n` +
            entries
              .map((e) => `[${e.type}] ${e.name} —— ${e.description}`)
              .join('\n')
          )
        }
        case 'search': {
          const results = memoryStore.search(args.query || '')
          if (results.length === 0) {
            return `没有找到与 "${args.query}" 相关的记忆。`
          }

          return (
            `搜索结果 (${results.length} 条匹配): \n` +
            results
              .map((r) => `[${r.type}] ${r.name} —— ${r.description}`)
              .join('\n')
          )
        }
        case 'read': {
          if (!args.filename) return '读取失败: 需要 filename 参数'
          return memoryStore.loadFile(filename) ?? `文件不存在: ${filename}`
        }
        case 'delete': {
          if (!filename) return '删除失败: 需要 filename 参数'
          return memoryStore.delete(args.filename)
            ? `已删除: ${filename}`
            : `文件不存在: ${filename}`
        }
        default:
          return `未知操作: ${action}`
      }
    },
  }
}
