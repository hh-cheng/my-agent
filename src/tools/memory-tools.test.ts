import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { MemoryStore } from '@/memory/store'
import { createMemoryTool } from './memory-tools'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
})

async function createStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'memory-tool-'))
  tempDirs.push(dir)
  const store = new MemoryStore(dir)
  await store.init()
  return store
}

describe('memory tool', () => {
  test('lint action returns filenames and issue previews', async () => {
    const store = await createStore()
    const tool = createMemoryTool(store)

    await store.save({
      name: 'Deploy process',
      description: 'User deploy process',
      type: 'user',
      content: 'Run ./missing-deploy.sh before release.',
    })

    const result = String(await tool.execute({ action: 'lint' }))

    expect(result).toContain('user_deploy-process.md')
    expect(result).toContain('stale_path')
    expect(result).toContain('内容预览')
  })
})
