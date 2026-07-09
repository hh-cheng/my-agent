import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { createDispatcher } from '@/commands'
import { createPluginCommands } from '@/commands/plugin'
import { ChannelGateway } from '@/channels/gateway'
import type { ChannelDefinition } from '@/channels/types'
import { createMockModel } from '@/mock/mock-model'
import { PluginManager } from '@/plugins/manager'
import type { PluginDefinition } from '@/plugins/types'
import { ToolRegistry } from '@/tools/tool-registry'

const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalEnvGreeting = process.env.PLUGIN_E2E_GREETING

let logs: string[] = []
let errors: string[] = []

beforeEach(() => {
  logs = []
  errors = []
  process.env.PLUGIN_E2E_GREETING = 'hello-from-env'
  console.log = mock((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  console.error = mock((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  console.log = originalConsoleLog
  console.error = originalConsoleError

  if (originalEnvGreeting === undefined) {
    delete process.env.PLUGIN_E2E_GREETING
  } else {
    process.env.PLUGIN_E2E_GREETING = originalEnvGreeting
  }
})

function output() {
  return [...logs, ...errors].join('\n')
}

describe('plugins E2E', () => {
  test('lists, loads, registers, executes, and unloads plugin tools', async () => {
    const registry = new ToolRegistry()
    const manager = new PluginManager(registry)
    let destroyCalled = false

    const plugin: PluginDefinition = {
      name: 'echo-plugin',
      version: '1.0.0',
      description: 'E2E echo plugin',
      config: {
        greeting: '${PLUGIN_E2E_GREETING}',
      },
      activate(api) {
        const config = api.getConfig()
        api.log(`activated with ${config.greeting}`)
        api.registerTools([
          {
            name: 'plugin_echo',
            description: 'Echo text with the plugin greeting',
            isReadOnly: true,
            isConcurrencySafe: true,
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string' },
              },
              required: ['text'],
              additionalProperties: false,
            },
            execute: async ({ text }: { text: string }) => {
              return `${config.greeting}:${text}`
            },
          },
        ])
      },
      destroy() {
        destroyCalled = true
      },
    }

    const availablePlugins = new Map([[plugin.name, plugin]])
    const dispatch = createDispatcher(
      createPluginCommands(manager, availablePlugins),
    )
    const ctx = {} as never

    expect(await dispatch('/plugin list', ctx)).toBe(true)
    expect(output()).toContain('[plugins] 插件列表')
    expect(output()).toContain('可加载')
    expect(output()).toContain('echo-plugin v1.0.0')

    logs = []
    expect(await dispatch('/plugin load echo-plugin', ctx)).toBe(true)
    expect(manager.list()).toEqual([
      {
        name: 'echo-plugin',
        version: '1.0.0',
        description: 'E2E echo plugin',
        tools: ['plugin_echo'],
      },
    ])
    expect(registry.get('plugin_echo')).toBeDefined()
    expect(output()).toContain('plugin:echo-plugin')
    expect(output()).toContain('activated with hello-from-env')
    expect(output()).toContain('已加载 echo-plugin')
    expect(output()).toContain('plugin_echo')

    const aiTools = registry.toAISDKFormat()
    expect(
      await aiTools.plugin_echo.execute?.({ text: 'works' }, {} as never),
    ).toBe('hello-from-env:works')

    logs = []
    expect(await dispatch('/plugin list', ctx)).toBe(true)
    expect(output()).toContain('已加载')
    expect(output()).toContain('工具: plugin_echo')
    expect(output()).not.toContain('可加载')

    logs = []
    expect(await dispatch('/plugin unload echo-plugin', ctx)).toBe(true)
    expect(destroyCalled).toBe(true)
    expect(registry.get('plugin_echo')).toBeUndefined()
    expect(manager.list()).toEqual([])
    expect(output()).toContain('已卸载 echo-plugin')

    logs = []
    expect(await dispatch('/plugin unload echo-plugin', ctx)).toBe(true)
    expect(output()).toContain('echo-plugin 未加载')
  })

  test('loads and unloads plugin channels', async () => {
    const registry = new ToolRegistry()
    const gateway = new ChannelGateway({
      registry,
      model: createMockModel(),
      buildSystem: () => 'test system',
    })
    const manager = new PluginManager(registry, gateway)

    const channel: ChannelDefinition = {
      name: 'plugin-channel',
      description: 'Channel from plugin',
      start() {},
      stop() {},
      async send() {},
    }

    const plugin: PluginDefinition = {
      name: 'channel-plugin',
      version: '1.0.0',
      description: 'E2E channel plugin',
      activate(api) {
        api.registerChannel(channel)
      },
    }

    await manager.load(plugin)

    expect(gateway.list()).toEqual([
      {
        name: 'plugin-channel',
        description: 'Channel from plugin',
      },
    ])
    expect(output()).toContain('注册通道 plugin-channel')

    expect(await manager.unload('channel-plugin')).toBe(true)
    expect(gateway.list()).toEqual([])
  })
})
