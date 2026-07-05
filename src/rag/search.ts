import type { StoredChunk, VectorStore } from './store'
import { cosineSimilarity, embed, type EmbeddingFn } from './embedder'

export interface SearchResult {
  score: number
  chunk: StoredChunk
  vectorScore: number
  keywordScore: number
}

const MMR_LAMBDA = 0.7
const VECTOR_WEIGHT = 0.7
const KEYWORD_WEIGHT = 0.3
const CANDIDATE_MULTIPLIER = 4

//* 混合检索
export async function hybridSearch(
  store: VectorStore,
  embedFn: EmbeddingFn,
  query: string,
  topK = 5,
): Promise<SearchResult[]> {
  const all = store.getAll()
  if (!all.length) return []

  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length)

  // 1.向量搜索
  const [queryVec] = await embed(embedFn, [query])
  const vectorResults = all
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryVec, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount)

  // 2.关键词检索
  const queryTerms = tokenize(query)
  const docCount = all.length
  const keywordResults = all
    .map((chunk) => ({
      chunk,
      score: bm25Score(queryTerms, chunk.text, docCount, all),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateCount)

  // 3.归一化 (值区间限制到 [0, 1])
  const vecNorm = normalizeMinMax(vectorResults.map((r) => r.score))
  const kwNorm = normalizeViaSigmoid(keywordResults.map((r) => r.score))

  // 4.合并
  const candidates = new Map<string, SearchResult>()

  for (let i = 0; i < vectorResults.length; i++) {
    const id = vectorResults[i].chunk.id
    candidates.set(id, {
      keywordScore: 0,
      vectorScore: vecNorm[i],
      chunk: vectorResults[i].chunk,
      score: vecNorm[i] * VECTOR_WEIGHT,
    })
  }

  for (let i = 0; i < keywordResults.length; i++) {
    const id = keywordResults[i].chunk.id
    const existing = candidates.get(id)
    if (existing) {
      existing.keywordScore = kwNorm[i]
      existing.score += kwNorm[i] * KEYWORD_WEIGHT
    } else {
      candidates.set(id, {
        vectorScore: 0,
        keywordScore: kwNorm[i],
        chunk: keywordResults[i].chunk,
        score: kwNorm[i] * KEYWORD_WEIGHT,
      })
    }
  }

  // 5.排序
  const sorted = Array.from(candidates.values()).sort(
    (a, b) => b.score - a.score,
  )

  // 6.MMR 去重
  return mmrSelect(sorted, topK)
}

//* === BM25 评分 START ===
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

function bm25Score(
  queryTerms: string[],
  docText: string,
  N: number,
  allDocs: StoredChunk[],
): number {
  const k1 = 1.2
  const b = 0.75
  const docTokens = tokenize(docText)
  const avgDl =
    allDocs.reduce((s, d) => s + tokenize(d.text).length, 0) / (N || 1)
  const dl = docTokens.length
  let score = 0

  for (const term of queryTerms) {
    const tf = docTokens.filter((t) => t === term).length
    const df = allDocs.filter((d) => tokenize(d.text).includes(term)).length
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)))
    score += idf * tfNorm
  }

  return score
}

//* === BM25 评分 END ===

//* === 归一化 START ===
function normalizeMinMax(scores: number[]) {
  if (scores.length === 0) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min || 1
  return scores.map((s) => (s - min) / range)
}

function normalizeViaSigmoid(scores: number[]) {
  return scores.map((s) => 1 / (1 + Math.exp(-s)))
}

//* === 归一化 END ===

//* === MMR 去重 START ===
export function mmrSelect(results: SearchResult[], topK: number) {
  if (results.length <= topK) return results

  const selected: SearchResult[] = [results[0]]
  const remaining = results.slice(1)

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0
    let bestMmr = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score
      const maxSim = Math.max(
        ...selected.map((s) =>
          jaccardSimilarity(s.chunk.text, remaining[i].chunk.text),
        ),
      )
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }

    selected.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }

  return selected
}

function jaccardSimilarity(a: string, b: string) {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))
  const intersection = Array.from(setA).filter((t) => setB.has(t)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

//* === MMR 去重 END ===
