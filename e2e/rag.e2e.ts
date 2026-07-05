import 'dotenv/config'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createDashScopeEmbedder, type EmbeddingFn } from '@/rag/embedder'
import { createRagTools } from '@/tools/rag-tools'
import { SqliteVectorStore } from '@/rag/sqlite-store'

let tmpRoot: string
let vectorStore: SqliteVectorStore
const runIfEmbedKey: typeof test = process.env.EMBED_API_KEY ? test : test.skip

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
    vectorStore = new SqliteVectorStore(join(tmpRoot, 'knowledge.db'))
  })

  afterEach(async () => {
    vectorStore.close()
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

  runIfEmbedKey(
    'ingests and searches with the real embedding model',
    async () => {
      const financePath = join(tmpRoot, 'finance-real.md')
      const recipePath = join(tmpRoot, 'recipe-real.md')

      await Bun.write(
        financePath,
        [
          '# 财务制度',
          '',
          '预算审批流程要求申请人先提交采购申请。',
          '报销金额超过五千元时，必须由部门负责人复核。',
        ].join('\n'),
      )
      await Bun.write(
        recipePath,
        [
          '# 烘焙食谱',
          '',
          '黄油曲奇需要面粉、黄油和糖。',
          '烘焙前需要预热烤箱并准备烤盘。',
        ].join('\n'),
      )

      const tools = createRagTools(vectorStore, createDashScopeEmbedder())
      const ingest = tools.find((tool) => tool.name === 'rag_ingest')
      const search = tools.find((tool) => tool.name === 'rag_search')

      expect(ingest).toBeDefined()
      expect(search).toBeDefined()

      await ingest?.execute({ path: financePath })
      await ingest?.execute({ path: recipePath })

      const result = String(
        await search?.execute({
          query: '预算审批和采购申请的流程',
          top_k: 1,
        }),
      )

      expect(vectorStore.size()).toBe(2)
      expect(result).toContain('finance-real.md')
      expect(result).toContain('预算审批')
      expect(result).not.toContain('recipe-real.md')
    },
    30_000,
  )
})
