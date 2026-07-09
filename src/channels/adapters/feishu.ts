import type { ServerType } from '@hono/node-server'
import type { Client, EventHandles, WSClient } from '@larksuiteoapi/node-sdk'

import type { PluginDefinition } from '@/plugins/types'
import {
  errorLabel,
  infoLabel,
  logger,
  successLabel,
  warnLabel,
} from '@/logging'
import type {
  ChannelDefinition,
  IncomingMessage,
  OutgoingMessage,
} from '../types'

interface FeishuConfig {
  port: number
  appId: string
  appSecret: string
}

type FeishuMessageEvent = Parameters<
  NonNullable<EventHandles['im.message.receive_v1']>
>[0]

interface FeishuTextContent {
  text?: string
}

interface DashboardWebhookBody {
  header?: {
    event_type?: string
  }
  event?: FeishuMessageEvent
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as FeishuTextContent
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

export class FeishuChannel implements ChannelDefinition {
  name = 'feishu'
  description = '飞书 Bot 消息通道 (长连接模式)'

  private messageHandler?: (msg: IncomingMessage) => void
  private larkClient?: Client
  private httpServer?: ServerType
  private wsClient?: WSClient

  constructor(private config: FeishuConfig) {}

  onMessage(handler: (msg: IncomingMessage) => void) {
    this.messageHandler = handler
  }

  async start() {
    await this.startDashboard()

    if (!this.config.appId || !this.config.appSecret) {
      logger.warn(
        `${warnLabel('feishu:config')} 未配置 APP_ID / APP_SECRET，仅启动 Dashboard`,
      )
      logger.info(
        `${infoLabel('feishu:dashboard')} 可用页面上的「发送测试消息」或 curl 测试 Channel 流程`,
      )
      return
    }

    const lark = await import('@larksuiteoapi/node-sdk')

    this.larkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    })

    const dispatcher = new lark.EventDispatcher({})

    dispatcher.register({
      'im.message.receive_v1': (data: FeishuMessageEvent) => {
        if (data.message.message_type !== 'text') return

        let text = parseTextContent(data.message.content)

        if (data.message.mentions) {
          for (const m of data.message.mentions) {
            text = text.replace(m.key, '').trim()
          }
        }

        if (text && this.messageHandler) {
          this.messageHandler({
            text,
            raw: data,
            channelId: data.message.chat_id,
            senderId: data.sender.sender_id?.open_id || 'unknown',
            senderName: data.sender.sender_id?.open_id || 'unknown',
          })
        }
      },
    })

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
    })

    await this.wsClient.start({ eventDispatcher: dispatcher })
    logger.success(`${successLabel('feishu:ws')} 长连接已建立 (无需 ngrok)`)
  }

  async stop() {
    this.wsClient?.close()
    if (this.httpServer) this.httpServer.close()
  }

  async send(message: OutgoingMessage) {
    if (!this.larkClient) {
      logger.warn(
        `${warnLabel('feishu:send')} 未配置飞书，跳过发送: ${message.text.slice(0, 50)}`,
      )
      return
    }

    try {
      await this.larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: message.channelId,
          msg_type: 'text',
          content: JSON.stringify({ text: message.text }),
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`${errorLabel('feishu:send')} 发送失败: ${msg}`)
    }
  }

  private async startDashboard() {
    const { Hono } = await import('hono')
    const { serve } = await import('@hono/node-server')

    const app = new Hono()

    // 模拟 webhook（Dashboard 测试用）
    app.post('/webhook/feishu', async (c) => {
      const body = await c.req.json<DashboardWebhookBody>()

      if (body.header?.event_type === 'im.message.receive_v1') {
        const event = body.event
        if (event?.message.message_type === 'text') {
          const text = parseTextContent(event.message.content)
            .replace(/@_user_\d+/g, '')
            .trim()
          if (text && this.messageHandler) {
            this.messageHandler({
              channelId: event.message.chat_id || 'web-test',
              senderId: event.sender?.sender_id?.open_id || 'web-dashboard',
              senderName: event.sender?.sender_id?.open_id || 'web-dashboard',
              text,
              raw: body,
            })
          }
        }
      }

      return c.json({ code: 0 })
    })

    // 状态面板
    app.get('/', (c) => {
      const feishuStatus = this.config.appId ? '已连接（长连接模式）' : '未配置'
      const html = `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <title>Super Agent — Channel Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #94a3b8; margin-bottom: 2rem; }
    .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; color: #38bdf8; margin-bottom: 0.75rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-ok { background: #065f46; color: #6ee7b7; }
    .badge-off { background: #78350f; color: #fcd34d; }
    .endpoint { font-family: monospace; background: #334155; padding: 4px 8px; border-radius: 4px; font-size: 0.85rem; }
    ul { list-style: none; }
    li { margin-bottom: 0.5rem; }
    textarea { width: 100%; background: #334155; border: 1px solid #475569; color: #e2e8f0; border-radius: 6px; padding: 0.75rem; font-family: monospace; font-size: 0.85rem; resize: vertical; min-height: 60px; }
    button { background: #2563eb; color: white; border: none; padding: 0.5rem 1.5rem; border-radius: 6px; cursor: pointer; margin-top: 0.5rem; font-size: 0.9rem; }
    button:hover { background: #1d4ed8; }
    #result { margin-top: 0.75rem; padding: 0.75rem; background: #334155; border-radius: 6px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; display: none; }
  </style>
</head>
<body>
  <h1>Super Agent v0.16</h1>
  <p class="subtitle">Channel Dashboard</p>

  <div class="card">
    <h2>Channel 状态</h2>
    <ul>
      <li><span class="badge ${this.config.appId ? 'badge-ok' : 'badge-off'}">${feishuStatus}</span> feishu — 飞书 Bot 消息通道</li>
    </ul>
  </div>

  <div class="card">
    <h2>发送测试消息</h2>
    <p style="color: #94a3b8; font-size: 0.85rem; margin-bottom: 0.75rem;">通过模拟 webhook 发消息给 Agent，回复在终端查看</p>
    <textarea id="msg" placeholder="输入要发给 Agent 的消息...">你好</textarea>
    <button onclick="sendTest()">发送</button>
    <div id="result"></div>
  </div>

  <script>
    async function sendTest() {
      const text = document.getElementById('msg').value.trim();
      if (!text) return;
      const result = document.getElementById('result');
      result.style.display = 'block';
      result.textContent = '发送中...';
      try {
        const body = {
          header: { event_type: 'im.message.receive_v1' },
          event: {
            message: { message_type: 'text', content: JSON.stringify({ text }), chat_id: 'web-test' },
            sender: { sender_id: { open_id: 'web-dashboard' } }
          }
        };
        const res = await fetch('/webhook/feishu', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        result.textContent = 'OK — 查看终端输出';
      } catch (e) {
        result.textContent = e.message;
      }
    }
  </script>
</body>
</html>`
      return c.html(html)
    })

    app.get('/health', (c) => c.text('OK'))

    this.httpServer = serve({ fetch: app.fetch, port: this.config.port })
    logger.info(
      `${infoLabel('feishu:dashboard')} http://localhost:${this.config.port}`,
    )
  }
}

export function createFeishuPlugin(): PluginDefinition {
  return {
    name: 'feishu',
    version: '1.0.0',
    description: '飞书 Bot 消息通道插件',
    config: {
      port: '${FEISHU_PORT}',
      appId: '${FEISHU_APP_ID}',
      appSecret: '${FEISHU_APP_SECRET}',
    },
    activate(api) {
      const config = api.getConfig()
      const rawPort =
        typeof config.port === 'number' ? config.port : Number(config.port)
      const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000

      api.registerChannel(
        new FeishuChannel({
          port,
          appId: String(config.appId || ''),
          appSecret: String(config.appSecret || ''),
        }),
      )
    },
  }
}
