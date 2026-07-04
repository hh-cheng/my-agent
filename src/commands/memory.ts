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
]
