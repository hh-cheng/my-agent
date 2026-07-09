import type { LanguageModel, ModelMessage } from 'ai'

import type { ToolRegistry } from '@/tools/tool-registry'
import { agentLoop, type BudgetState } from '@/agent/loop'
import type { ChannelDefinition, IncomingMessage } from './types'
import {
  errorLabel,
  infoLabel,
  logger,
  successLabel,
  toolLabel,
} from '@/logging'

interface GatewayOptions {
  model: LanguageModel
  registry: ToolRegistry
  budget?: BudgetState
  buildSystem(): string | Promise<string>
}

export class ChannelGateway {
  private channels = new Map<string, ChannelDefinition>()
  private sessions = new Map<string, ModelMessage[]>()
  private budget: BudgetState
  private started = false

  constructor(private options: GatewayOptions) {
    this.budget = options.budget ?? { used: 0, limit: 200_000 }
  }

  list() {
    return Array.from(this.channels.values()).map((c) => ({
      name: c.name,
      description: c.description,
    }))
  }

  register(channel: ChannelDefinition) {
    this.channels.set(channel.name, channel)
    logger.info(`${infoLabel('gateway:register')} ${channel.name}`)

    channel.onMessage?.((msg: IncomingMessage) => {
      void this.handleIncoming(channel.name, msg).catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(
          `${errorLabel(`gateway:${channel.name}`)} 处理消息失败: ${message}`,
        )
      })
    })

    if (this.started) {
      void this.startChannel(channel.name, channel)
    }
  }

  async unregister(name: string) {
    const channel = this.channels.get(name)
    if (!channel) return false

    try {
      await channel.stop()
      logger.debug(`${infoLabel(`gateway:${name}`)} 已停止`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`${errorLabel(`gateway:${name}`)} 停止失败: ${msg}`)
    }

    this.channels.delete(name)
    for (const sessionKey of this.sessions.keys()) {
      if (sessionKey.startsWith(`${name}:`)) {
        this.sessions.delete(sessionKey)
      }
    }
    logger.info(`${infoLabel('gateway:unregister')} ${name}`)
    return true
  }

  async startAll() {
    this.started = true
    for (const [name, ch] of this.channels) {
      await this.startChannel(name, ch)
    }
  }

  async stopAll() {
    this.started = false
    for (const [name, ch] of this.channels) {
      try {
        await ch.stop()
        logger.debug(`${infoLabel(`gateway:${name}`)} 已停止`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`${errorLabel(`gateway:${name}`)} 停止失败: ${msg}`)
      }
    }
  }

  private async startChannel(name: string, channel: ChannelDefinition) {
    try {
      await channel.start()
      logger.success(`${successLabel(`gateway:${name}`)} 已启动`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`${errorLabel(`gateway:${name}`)} 启动失败: ${msg}`)
    }
  }

  private async handleIncoming(channelName: string, msg: IncomingMessage) {
    const sessionKey = `${channelName}:${msg.senderId}`
    logger.raw()
    logger.info(
      `${infoLabel(`gateway:${channelName}:in`)} ${msg.senderName}(${msg.senderId}): ${msg.text}`,
    )

    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, [])
      logger.debug(`${infoLabel('gateway:session')} 新会话 ${sessionKey}`)
    }

    const messages = this.sessions.get(sessionKey)!
    const userMsg: ModelMessage = { role: 'user', content: msg.text }
    messages.push(userMsg)

    const system = await this.options.buildSystem()
    await agentLoop({
      system,
      messages,
      budget: this.budget,
      model: this.options.model,
      tools: this.options.registry,
    })

    let replyText = ''
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && lastMsg.role === 'assistant') {
      const content = lastMsg.content
      if (typeof content === 'string') {
        replyText = content
      } else if (Array.isArray(content)) {
        replyText = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
      }
    }

    if (replyText) {
      const channel = this.channels.get(channelName)
      if (channel) {
        await channel.send({
          text: replyText,
          channelId: msg.channelId,
          recipientId: msg.senderId,
        })
        logger.info(
          `${toolLabel(`gateway:${channelName}:out`)} ${replyText.slice(0, 80)}${replyText.length > 80 ? '...' : ''}`,
        )
      }
    }
  }
}
