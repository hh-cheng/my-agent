import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { MemoryStore } from './store'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
})

async function createStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'memory-store-'))
  tempDirs.push(dir)
  const store = new MemoryStore(dir)
  await store.init()
  return store
}

describe('MemoryStore', () => {
  test('saves, lists, searches, reads, and deletes memory entries', async () => {
    const store = await createStore()

    const filename = await store.save({
      name: 'TypeScript preference',
      description: 'User prefers TypeScript examples',
      type: 'user',
      content: 'Prefer TypeScript when showing code examples.',
    })

    expect(filename).toBe('user_typescript-preference.md')
    expect(await store.list()).toMatchObject([
      {
        name: 'TypeScript preference',
        description: 'User prefers TypeScript examples',
        type: 'user',
        content: 'Prefer TypeScript when showing code examples.',
      },
    ])

    expect(await store.search('examples')).toHaveLength(1)
    expect(await store.loadFile(filename)).toContain('TypeScript preference')
    expect(await store.buildPromptSection()).toContain('[记忆系统] 共 1 条记忆')

    expect(await store.delete(filename)).toBe(true)
    expect(await store.list()).toEqual([])
  })

  test('lints duplicate memory names', async () => {
    const store = await createStore()

    await store.save({
      name: 'Deploy process',
      description: 'User deploy process',
      type: 'user',
      content: 'Run ./deploy.sh before release.',
    })
    await store.save({
      name: 'Deploy process',
      description: 'Project deploy process',
      type: 'project',
      content: 'Deploy notes live in docs/deploy.md.',
    })

    const reports = await store.lint()

    expect(reports).toHaveLength(2)
    expect(reports.flatMap((r) => r.issues.map((i) => i.kind))).toContain(
      'duplicate_name',
    )
  })
})
