export interface PromptContext {
  toolCount: number
  sessionId: string
  deferredToolSummary: string
  sessionMessageCount: number
}

export type PipeFn = (ctx: PromptContext) => string | null

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = []

  pipe(name: string, fn: PipeFn) {
    this.pipes.push({ name, fn })
    return this
  }

  build(ctx: PromptContext) {
    const sections: string[] = []

    for (const { fn } of this.pipes) {
      const result = fn(ctx)
      if (result !== null) {
        sections.push(result)
      }
    }

    return sections.join('\n\n')
  }

  debug(ctx: PromptContext) {
    console.log('\n=== Prompt Pipe Debug ===')
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx)
      const status = result !== null ? `[ON] ${result.length}` : '[OFF]'
      console.log(`${name}: ${status}`)
    }
    console.log('=== End of Debug ===\n')
  }
}
