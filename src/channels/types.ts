export interface IncomingMessage {
  channelId: string
  senderId: string
  senderName: string
  text: string
  raw?: unknown
}

export interface OutgoingMessage {
  channelId: string
  recipientId: string
  text: string
}

export interface ChannelDefinition {
  name: string
  description: string

  stop(): Promise<void> | void
  start(): Promise<void> | void
  send(message: OutgoingMessage): Promise<void>

  onMessage?: (handler: (msg: IncomingMessage) => void) => void
}
