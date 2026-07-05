export const DIMS = 128

export type EmbeddingFn = (texts: string[]) => Promise<number[][]>

// 创建一个真正调用 SiliconFlow embedding API 的函数，API key 来自 EMBED_API_KEY。
// 返回值符合通用 EmbeddingFn 形状，因此调用方不用关心具体供应商细节。
export function createDashScopeEmbedder(): EmbeddingFn {
  const apiKey = process.env.EMBED_API_KEY
  if (!apiKey) {
    throw new Error('Missing EMBED_API_KEY for SiliconFlow embeddings')
  }

  return async (texts: string[]) => {
    const resp = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        dimensions: DIMS,
        encoding_format: 'float',
        model: 'Qwen/Qwen3-VL-Embedding-8B',
      }),
    })

    if (!resp.ok) {
      throw new Error(
        `Embedding API error: ${resp.status} ${await resp.text()}`,
      )
    }

    const data: any = await resp.json()
    return data.data.map((d: any) => d.embedding as number[])
  }
}

const embedCache = new Map<string, number[]>()

// embed 是对任意 EmbeddingFn 的通用包装层：
// 先复用本地缓存，只把未命中的文本交给实际的 embedding 函数，
// 最后按输入 texts 的原始顺序返回向量。
export async function embed(
  fn: EmbeddingFn,
  texts: string[],
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length)
  const uncached: { idx: number; text: string }[] = []

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i])
    if (cached) {
      results[i] = cached
    } else {
      uncached.push({ idx: i, text: texts[i] })
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map((u) => u.text))
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i].idx] = vectors[i]
      embedCache.set(uncached[i].text, vectors[i])
    }
  }

  return results
}

//* 结果接近1: 语义很相似; 接近0: 关系弱; 小于0: 方向相反，表示不相似
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1)
}
