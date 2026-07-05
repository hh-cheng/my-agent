import { Database } from 'bun:sqlite'

import type { Chunk } from './chunker'
import { cosineSimilarity, embed, type EmbeddingFn } from './embedder'
import { mmrSelect, type SearchResult } from './search'
import type { StoredChunk } from './store'

const VECTOR_WEIGHT = 0.7
const KEYWORD_WEIGHT = 0.3
const CANDIDATE_MULTIPLIER = 4

interface ChunkRow {
  id: string
  text: string
  source: string
  chunk_index: number
  estimated_tokens: number
  embedding: string
  updated_at: number
}

export class SqliteVectorStore {
  private db: Database

  constructor(dbPath = 'knowledge.db') {
    this.db = new Database(dbPath, { create: true })
    this.createTables()
  }

  private createTables() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        source UNINDEXED
      );
    `)
  }

  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now()

    this.db
      .query(
        `INSERT INTO chunks
          (id, text, source, chunk_index, estimated_tokens, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text,
          source = excluded.source,
          chunk_index = excluded.chunk_index,
          estimated_tokens = excluded.estimated_tokens,
          embedding = excluded.embedding,
          updated_at = excluded.updated_at`,
      )
      .run(
        chunk.id,
        chunk.text,
        chunk.source,
        chunk.index,
        chunk.estimatedTokens,
        JSON.stringify(embedding),
        now,
      )

    this.db.query('DELETE FROM chunks_fts WHERE id = ?').run(chunk.id)
    this.db
      .query('INSERT INTO chunks_fts (id, text, source) VALUES (?, ?, ?)')
      .run(chunk.id, chunk.text, chunk.source)
  }

  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    const tx = this.db.transaction((batch) => {
      for (const { chunk, embedding } of batch) this.add(chunk, embedding)
    })

    tx(items)
  }

  getAll(): StoredChunk[] {
    const rows = this.db
      .query('SELECT * FROM chunks ORDER BY source, chunk_index')
      .all() as ChunkRow[]

    return rows.map(rowToStoredChunk)
  }

  vectorSearch(
    queryEmbedding: number[],
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    return this.getAll()
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  keywordSearch(
    query: string,
    topK: number,
  ): Array<{ chunk: StoredChunk; score: number }> {
    const ftsQuery = toFtsQuery(query)
    if (!ftsQuery) return []

    try {
      const rows = this.db
        .query(
          `SELECT c.*, bm25(chunks_fts) AS rank
          FROM chunks_fts
          JOIN chunks c ON c.id = chunks_fts.id
          WHERE chunks_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
        )
        .all(ftsQuery, topK) as Array<ChunkRow & { rank: number }>

      return rows.map((row) => ({
        chunk: rowToStoredChunk(row),
        score: row.rank < 0 ? -row.rank / (1 - row.rank) : 1 / (1 + row.rank),
      }))
    } catch {
      return []
    }
  }

  size(): number {
    const row = this.db.query('SELECT COUNT(*) AS n FROM chunks').get() as {
      n: number
    }

    return row.n
  }

  clear(): void {
    this.db.exec('DELETE FROM chunks; DELETE FROM chunks_fts;')
  }

  sources(): string[] {
    const rows = this.db
      .query('SELECT DISTINCT source FROM chunks ORDER BY source')
      .all() as Array<{ source: string }>

    return rows.map((row) => row.source)
  }

  close(): void {
    this.db.close()
  }

  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK = 5,
  ): Promise<SearchResult[]> {
    const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, this.size())
    if (candidateCount === 0) return []

    const [queryVec] = await embed(embedFn, [query])
    const vectorResults = this.vectorSearch(queryVec, candidateCount)
    const keywordResults = this.keywordSearch(query, candidateCount)

    const vecScores = normalizeMinMax(vectorResults.map((r) => r.score))
    const kwScores = normalizeMinMax(keywordResults.map((r) => r.score))
    const candidates = new Map<string, SearchResult>()

    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[i].chunk.id
      candidates.set(id, {
        chunk: vectorResults[i].chunk,
        score: vecScores[i] * VECTOR_WEIGHT,
        vectorScore: vecScores[i],
        keywordScore: 0,
      })
    }

    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[i].chunk.id
      const existing = candidates.get(id)
      if (existing) {
        existing.keywordScore = kwScores[i]
        existing.score += kwScores[i] * KEYWORD_WEIGHT
      } else {
        candidates.set(id, {
          chunk: keywordResults[i].chunk,
          score: kwScores[i] * KEYWORD_WEIGHT,
          vectorScore: 0,
          keywordScore: kwScores[i],
        })
      }
    }

    const sorted = Array.from(candidates.values()).sort(
      (a, b) => b.score - a.score,
    )

    return mmrSelect(sorted, topK)
  }
}

function rowToStoredChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    index: row.chunk_index,
    estimatedTokens: row.estimated_tokens,
    embedding: JSON.parse(row.embedding),
    addedAt: row.updated_at,
  }
}

function toFtsQuery(query: string) {
  const terms = query
    .toLowerCase()
    .replace(/[^\w一-鿿]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)

  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min || 1
  return scores.map((s) => (s - min) / range)
}
