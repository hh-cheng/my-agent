import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { VectorStore } from '@/rag/store'
import type { EmbeddingFn } from '@/rag/embedder'
import { createRagTools } from '@/tools/rag-tools'

let tmpRoot: string

const fakeEmbedder: EmbeddingFn = async (texts) => {
  return texts.map((text) => {
    const budgetScore = scoreTerms(text, ['预算', '审批', '报销', '采购'])
    const recipeScore = scoreTerms(text, ['食谱', '面粉', '烘焙', '黄油'])
    const agentScore = scoreTerms(text, ['agent', '工具', '上下文'])

    return [budgetScore, recipeScore, agentScore, 1]
  })
}

function scoreTerms(text: string, terms: string[]) {
  return terms.reduce((score, term) => {
    return score + (text.toLowerCase().includes(term.toLowerCase()) ? 1 : 0)
  }, 0)
}

describe('RAG E2E', () => {
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'my-agent-rag-'))
  })

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  test('ingests files and searches the most relevant chunk without external APIs', async () => {
    const financePath = join(tmpRoot, 'finance.md')
    const recipePath = join(tmpRoot, 'recipe.md')

    await Bun.write(
      financePath,
      [
        '# 财务制度',
        '',
        '预算审批需要先提交采购申请。',
        '超过五千元的报销必须由部门负责人复核。',
      ].join('\n'),
    )
    await Bun.write(
      recipePath,
      [
        '# 烘焙食谱',
        '',
        '面粉、黄油和糖用于制作饼干。',
        '烘焙前需要预热烤箱。',
      ].join('\n'),
    )

    const vectorStore = new VectorStore()
    const tools = createRagTools(vectorStore, fakeEmbedder)
    const ingest = tools.find((tool) => tool.name === 'rag_ingest')
    const search = tools.find((tool) => tool.name === 'rag_search')

    expect(ingest).toBeDefined()
    expect(search).toBeDefined()

    const firstIngestResult = await ingest?.execute({ path: financePath })
    const secondIngestResult = await ingest?.execute({ path: recipePath })

    expect(firstIngestResult).toContain('已导入')
    expect(secondIngestResult).toContain('知识库共 2 个片段')
    expect(vectorStore.size()).toBe(2)

    const result = String(
      await search?.execute({ query: '预算审批流程是什么？', top_k: 1 }),
    )

    expect(result).toContain('finance.md')
    expect(result).toContain('预算审批')
    expect(result).not.toContain('recipe.md')
  })
})
