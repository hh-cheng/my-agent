import { logStyle, successLabel } from '@/logging'

export interface PromptContext {
  toolCount: number
  sessionId: string
  deferredToolSummary: string
  sessionMessageCount: number
}

export type PipeFn = (
  ctx: PromptContext,
) => string | null | Promise<string | null>

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn) {
    this.pipes.push({ name, fn })
    return this
  }

  async build(ctx: PromptContext) {
    const sections: string[] = []

    for (const { fn } of this.pipes) {
      const result = await fn(ctx)
      if (result !== null) {
        sections.push(result)
      }
    }

    return sections.join('\n\n')
  }

  async debug(ctx: PromptContext) {
    console.log(`\n${logStyle.banner('=== Prompt Pipe Debug ===')}`)
    for (const { name, fn } of this.pipes) {
      const result = await fn(ctx)
      const status =
        result !== null
          ? `${successLabel('ON')} ${result.length}`
          : logStyle.muted('[OFF]')
      console.log(`${logStyle.info(name)}: ${status}`)
    }
    console.log(`${logStyle.banner('=== End of Debug ===')}\n`)
  }
}
