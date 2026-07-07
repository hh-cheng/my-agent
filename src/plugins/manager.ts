import { errorLabel, logger, toolLabel } from '@/logging'
import type { ToolRegistry } from '@/tools/tool-registry'
import type { PluginDefinition, PluginConfig, PluginApi } from './types'

interface LoadedPlugin {
  tools: string[]
  definition: PluginDefinition
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()

  constructor(private registry: ToolRegistry) {}

  async load(definition: PluginDefinition, config?: PluginConfig) {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`)
    }

    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config,
    })

    const registeredTools: string[] = []

    const api: PluginApi = {
      registerTools: (tools) => {
        this.registry.register(...tools)
        registeredTools.push(...tools.map((tool) => tool.name))
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        logger.raw(`${toolLabel(`plugin:${definition.name}`)} ${message}`)
      },
    }

    try {
      await definition.activate(api)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(
        `${errorLabel(`plugin:${definition.name}`)} 激活失败: ${msg}`,
      )
      throw err
    }

    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools,
    })

    return registeredTools
  }

  async unload(name: string) {
    const plugin = this.plugins.get(name)
    if (!plugin) return false

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`${errorLabel(`plugin:${name}`)} destroy 出错: ${msg}`)
      }
    }

    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName)
    }

    this.plugins.delete(name)
    return true
  }

  async unloadAll() {
    const names = Array.from(this.plugins.keys())
    for (const name of names) {
      await this.unload(name)
    }
  }

  get(name: string) {
    return this.plugins.get(name)
  }

  list() {
    return Array.from(this.plugins.values()).map((p) => ({
      tools: p.tools,
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
    }))
  }

  private resolveEnvVars(config: PluginConfig) {
    const resolved: PluginConfig = {}

    for (const [key, value] of Object.entries(config)) {
      if (
        typeof value === 'string' &&
        value.startsWith('${') &&
        value.endsWith('}')
      ) {
        const envKey = value.slice(2, -1)
        resolved[key] = process.env[envKey] || ''
      } else {
        resolved[key] = value
      }
    }

    return resolved
  }
}
