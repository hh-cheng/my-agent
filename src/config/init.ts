import { createInterface } from 'node:readline'
import fs from 'node:fs'
import { logger } from '@/logging'
import { CONFIG_FILE } from './loader.js'
import { SuperAgentConfigSchema } from './schema.js'

const ENV_FILE = '.env'

function writeEnvVariables(values: Record<string, string>) {
  const existed = fs.existsSync(ENV_FILE)
  const lines = existed ? fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/) : []

  for (const [name, value] of Object.entries(values)) {
    const assignment = `${name}=${JSON.stringify(value)}`
    const index = lines.findIndex((line) =>
      new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line),
    )

    if (index >= 0) lines[index] = assignment
    else lines.push(assignment)
  }

  while (lines.at(-1) === '') lines.pop()
  fs.writeFileSync(ENV_FILE, `${lines.join('\n')}\n`)
  logger.success(`✓ ${ENV_FILE} 已${existed ? '更新' : '生成'}`)
}

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => {
      logger.raw(q)
      rl.question('  > ', resolve)
    })

  try {
    logger.info('\nSuper Agent 初始化向导\n')

    if (fs.existsSync(CONFIG_FILE)) {
      const overwrite = await ask(`${CONFIG_FILE} 已存在，覆盖? (y/N): `)
      if (overwrite.toLowerCase() !== 'y') {
        logger.warn('已取消\n')
        return
      }
    }

    // ── 模型选择 ──────────────────────────
    logger.info('选择模型:\n')
    logger.raw('  1. deepseek-v4-pro   (推荐，均衡)')
    logger.raw('  2. deepseek-v4-flash (快速，便宜)')
    const modelChoice = (await ask('模型 [1]: ')) || '1'
    const models: Record<string, string> = {
      '1': 'deepseek-v4-pro',
      '2': 'deepseek-v4-flash',
    }
    const modelName = models[modelChoice] || 'deepseek-v4-pro'

    // ── API Key ──────────────────────────
    const apiKey = await ask(
      '\nDeepseek API Key (留空则从环境变量 DEEPSEEK_API_KEY 读取): ',
    )

    // ── 飞书 Channel ──────────────────────────
    const enableFeishu =
      (await ask('\n启用飞书 Channel? (y/N): ')).toLowerCase() === 'y'
    let feishuAppId = ''
    let feishuAppSecret = ''
    if (enableFeishu) {
      feishuAppId = await ask('飞书 App ID (留空则读取 FEISHU_APP_ID): ')
      feishuAppSecret = await ask(
        '飞书 App Secret (留空则读取 FEISHU_APP_SECRET): ',
      )
    }

    // ── Sub-Agent ──────────────────────────
    const concurrentStr = await ask('\n子 Agent 最大并发数 [3]: ')
    const parsedConcurrent = Number.parseInt(concurrentStr, 10)
    const maxConcurrent = concurrentStr.trim() ? parsedConcurrent : 3
    if (
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > 10
    ) {
      logger.warn('并发数必须是 1–10 的整数，已使用默认值 3')
    }

    // ── 生成配置 ──────────────────────────
    const config = SuperAgentConfigSchema.parse({
      version: '1.0',
      model: {
        provider: 'deepseek',
        name: modelName,
        baseURL: 'https://api.deepseek.com',
        apiKey: '${DEEPSEEK_API_KEY}',
      },
      plugins: [],
      channels: {
        feishu: {
          enabled: enableFeishu,
          appId: enableFeishu ? '${FEISHU_APP_ID}' : '',
          appSecret: enableFeishu ? '${FEISHU_APP_SECRET}' : '',
          port: 3000,
        },
      },
      agents: {
        maxSpawnDepth: 1,
        maxConcurrent:
          Number.isInteger(maxConcurrent) &&
          maxConcurrent >= 1 &&
          maxConcurrent <= 10
            ? maxConcurrent
            : 3,
        defaultTimeout: 60000,
        budgetLimit: 200000,
      },
      security: {
        defaultRole: 'owner',
        auditLog: true,
        bashTimestamp: true,
      },
      memory: { dataDir: '.' },
      rag: {
        enabled: true,
        docsDir: 'docs',
        databasePath: 'knowledge.db',
      },
      cron: { enabled: true, dataDir: '.' },
      session: { id: 'default' },
      usage: { trackingFile: '.usage/today.jsonl' },
    })

    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
    logger.success(`\n✓ ${CONFIG_FILE} 已生成`)

    const envValues: Record<string, string> = {}
    if (apiKey) envValues.DEEPSEEK_API_KEY = apiKey
    if (enableFeishu && feishuAppId) envValues.FEISHU_APP_ID = feishuAppId
    if (enableFeishu && feishuAppSecret) {
      envValues.FEISHU_APP_SECRET = feishuAppSecret
    }
    if (Object.keys(envValues).length > 0) writeEnvVariables(envValues)

    logger.info('\n启动 Agent: bun run dev\n')
  } finally {
    rl.close()
  }
}
