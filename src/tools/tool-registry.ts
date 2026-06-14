import { jsonSchema, type streamText } from 'ai'

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

  registry(...tools: ToolDefinition[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  get(name: string) {
    return this.tools.get(name)
  }

  getAll() {
    return Array.from(this.tools.values())
  }

  toAISDKFormat(): StreamTextTools {
    const result: StreamTextTools = {}

    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars
      const executeFn = tool.execute
      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
        execute: async (ipt: any) => {
          const raw = await executeFn(ipt)
          const text =
            typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
          return truncate(text, maxChars)
        },
      }
    }

    return result
  }
}
