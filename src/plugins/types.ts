import type { ToolDefinition } from '@/tools/tool-registry'

export interface PluginConfig {
  [key: string]: string | number | boolean
}

export interface PluginApi {
  getConfig(): PluginConfig
  log(message: string): void
  // 接收注册工具方法而不是接收 toolRegister，防止 plugin 删 Agent 的方法
  registerTools(tools: ToolDefinition[]): void
}

export interface PluginDefinition {
  name: string
  version: string
  description: string
  config?: PluginConfig

  //* 生命周期, 类比 useEffect
  destroy?(): Promise<void> | void
  activate(api: PluginApi): Promise<void> | void
}
