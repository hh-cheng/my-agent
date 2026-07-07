import { logger } from '@/logging'
import type { CommandHandler } from './index.js'
import type { PluginManager } from '../plugins/manager.js'
import type { PluginDefinition } from '../plugins/types.js'

export function createPluginCommands(
  pluginManager: PluginManager,
  availablePlugins: Map<string, PluginDefinition>,
): CommandHandler[] {
  return [
    // /plugin 或 /plugin list
    (cmd) => {
      if (cmd !== '/plugin' && cmd !== '/plugin list') return false

      const loaded = pluginManager.list()
      const unloaded = Array.from(availablePlugins.entries()).filter(
        ([name]) => !loaded.find((p) => p.name === name),
      )

      if (loaded.length === 0 && unloaded.length === 0) {
        logger.warn('\n[plugins] 没有可用的插件。\n')
        return true
      }

      logger.info('\n[plugins] 插件列表')
      if (loaded.length > 0) {
        logger.success('  已加载：')
        for (const p of loaded) {
          logger.raw(`    ${p.name} v${p.version} — ${p.description}`)
          logger.raw(`      工具: ${p.tools.join(', ') || '(无)'}`)
        }
      }
      if (unloaded.length > 0) {
        logger.info('  可加载：')
        for (const [name, def] of unloaded) {
          logger.raw(`    ${name} v${def.version} — ${def.description}`)
        }
      }
      logger.raw()
      return true
    },

    // /plugin load <name>
    async (cmd) => {
      const match = cmd.match(/^\/plugin\s+load\s+(\S+)$/)
      if (!match) return false
      const name = match[1]

      const def = availablePlugins.get(name)
      if (!def) {
        logger.warn(`\n[plugins] 找不到插件: ${name}\n`)
        return true
      }

      const tools = await pluginManager.load(def)
      logger.success(
        `\n[plugins] 已加载 ${name}，注册了 ${tools.length} 个工具：`,
      )
      for (const t of tools) logger.raw(`    ${t}`)
      logger.raw()

      return true
    },

    // /plugin unload <name>
    async (cmd) => {
      const match = cmd.match(/^\/plugin\s+unload\s+(\S+)$/)
      if (!match) return false
      const name = match[1]

      const ok = await pluginManager.unload(name)
      if (ok) {
        logger.success(`\n[plugins] 已卸载 ${name}，相关工具已移除\n`)
      } else {
        logger.warn(`\n[plugins] ${name} 未加载\n`)
      }

      return true
    },
  ]
}
