export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface MCPCallResult {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}
