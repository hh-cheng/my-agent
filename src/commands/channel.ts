import type { CommandHandler } from './index.js'
import type { ChannelGateway } from '../channels/gateway.js'
import { infoLabel, logger, warnLabel } from '../logging.js'

export function createChannelCommands(
  gateway: ChannelGateway,
): CommandHandler[] {
  return [
    (cmd, _ctx) => {
      if (cmd !== '/channel' && cmd !== '/channel list') return false

      const channels = gateway.list()
      if (channels.length === 0) {
        logger.warn(`\n${warnLabel('channels')} 没有注册的通道。\n`)
        return true
      }

      logger.info(`\n${infoLabel('channels')} 已注册通道`)
      for (const ch of channels) {
        logger.raw(`  ${ch.name} — ${ch.description}`)
      }
      logger.raw()
      return true
    },
  ]
}
