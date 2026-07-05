import type { ModelMessage } from 'ai'

import { agentLoop } from '@/agent/loop'
import type { CommandHandler } from '.'

export const memoryCommands: CommandHandler[] = [
  async (cmd, ctx) => {
    if (cmd !== '/memory' && cmd !== 'memory') return false

    const entries = await ctx.memoryStore!.list()
    console.log(`\n[记忆系统] 共 ${entries.length} 条记忆`)
    for (const e of entries) {
      console.log(`[${e.type}] ${e.name} —— ${e.description}`)
    }
    console.log('')

    return true
  },

  async (cmd, ctx) => {
    if (!cmd.startsWith('/memory search ')) return false

    const query = cmd.slice('/memory search '.length).trim()
    const results = await ctx.memoryStore!.search(query)
    console.log(`\n[记忆搜索] "${query}" -> ${results.length} 条结果`)
    for (const r of results) {
      console.log(`[${r.type}] ${r.name} —— ${r.description}`)
    }
    console.log('')

    return true
  },

  async (cmd, ctx) => {
    if (cmd !== '/lint' && cmd !== 'lint') return false

    const reports = await ctx.memoryStore!.lint()
    if (reports.length === 0) {
      console.log('\n[lint] 记忆库健康，没有发现问题。\n')
      return true
    }

    console.log(`\n[lint] 记忆库有 ${reports.length} 条警告`)

    for (const r of reports) {
      console.log(
        `📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`,
      )
      for (const issue of r.issues) {
        console.log(`  • ${issue.kind}: ${issue.message}`)
      }
    }

    console.log('')

    return true
  },

  async (cmd, ctx) => {
    if (cmd !== '/dream' && cmd !== 'dream') return false

    console.log('\n[dream] 开始记忆整理...')
    const dreamPrompt = [
      '请对记忆库做一次完整的整理（dream），按以下阶段执行：',
      '',
      '**阶段 1：定位** — 用 memory lint 扫描全库（结果已包含内容预览和问题清单，不需要逐条 read）。',
      '**阶段 2：整理** — 根据 lint 报告直接操作：',
      '  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉',
      '  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
      '  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新',
      '**阶段 3：报告** — 用一段文字总结这次整理做了什么。',
      '',
      '注意：read 和 delete 都需要传 filename（如 project_deploy-process.md），不是 name。',
    ].join('\n')

    const beforeCount = ctx.messages.length
    const userMsg: ModelMessage = { role: 'user', content: dreamPrompt }
    ctx.messages.push(userMsg)
    ctx.timestamps.set(ctx.messages.length - 1, Date.now())

    const currentSystem = await ctx.builder.build(ctx.makePromptCtx())
    await agentLoop({
      model: ctx.model,
      budget: ctx.budget,
      tracker: ctx.tracker,
      modelId: ctx.modelId,
      messages: ctx.messages,
      system: currentSystem,
      tools: ctx.registry,
    })

    const now = Date.now()
    for (let i = beforeCount; i < ctx.messages.length; i++) {
      if (!ctx.timestamps.has(i)) ctx.timestamps.set(i, now)
    }
    ctx.sessionStore.appendAll(ctx.messages.slice(beforeCount))

    console.log('[dream 完成]\n')
    return true
  },
]
